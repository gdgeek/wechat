import { HttpException } from '@nestjs/common';
import type { Context, Row, Services } from '../core/contracts';
import type { ApiRouter } from '../core/router';

const success = (data: unknown, message = 'success') => ({ success: true, message, data });
const userFields = (row: Row) => Object.fromEntries(['id', 'tel', 'nickname', 'avatar', 'role'].map(name => [name, row[name] ?? null]));
function bad(message: string, status = 400): never { throw new HttpException(message, status); }
function issuer(ctx: Context): string {
  return process.env.PUBLIC_ORIGIN || `${ctx.req.protocol}://${ctx.req.get('host')}`;
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function numeric(value: unknown): boolean {
  return (typeof value === 'number' || typeof value === 'string' && value.trim() !== '' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim())) && Number.isFinite(Number(value));
}
function errorCode(error: unknown): number { return error instanceof HttpException ? error.getStatus() : Number((error as Row)?.status || 500); }

export function registerIntegrations(router: ApiRouter, services: Services): void {
  const { db, auth, integrations: api } = services;
  router.add('POST', '/v2/site/login', async ctx => {
    const identity = await api.codeSession(ctx.body.code);
    const unionid = nonempty(identity.unionid) ? identity.unionid : null;
    let user: Row | null;
    if (unionid) {
      user = await db.one('SELECT * FROM `user` WHERE unionid=? LIMIT 1', [unionid]);
      if (!user) user = await db.insert('user', { openid: identity.openid, unionid, role: 'user' });
    } else user = await db.one('SELECT * FROM `user` WHERE openid=? LIMIT 1', [identity.openid]);
    if (!user) return bad('微信账号尚未关联，请先完成账号授权', 401);
    user = await auth.role(user);
    return success({ token: auth.issue(user, 'v2-user', issuer(ctx)), user: userFields(user), openid: user.openid, unionid: user.unionid ?? null }, unionid ? 'success' : 'unionid not available (check if user has authorized or follows related official account)');
  });
  router.add('POST', '/v2/site/refresh-token', async ctx => {
    if (!nonempty(ctx.body.refreshToken)) return bad('Invalid or expired refreshToken', 401);
    return success({ token: await auth.refresh(ctx.body.refreshToken, 'v2-user', issuer(ctx)) }, 'refresh success');
  });
  router.add('POST', '/v2/wechat/profile', async ctx => {
    let user = await auth.bearer(ctx, 'v2-user');
    const patch: Row = {};
    for (const field of ['avatar', 'nickname']) {
      if (ctx.body[field] !== undefined && (typeof ctx.body[field] !== 'string' || ctx.body[field].length > 255)) return bad(`${field} is invalid`);
      if (ctx.body[field] && ctx.body[field] !== user[field]) patch[field] = ctx.body[field];
    }
    if (Object.keys(patch).length) user = await db.update('user', user.id, patch);
    return success({ user: userFields(user) }, 'Profile updated successfully');
  });
  router.add('POST', '/v2/wechat/bind-phone', async ctx => {
    let user = await auth.bearer(ctx, 'v2-user');
    if (!ctx.body.code) return bad('code parameter is required');
    let phone: Row;
    try { phone = await api.phone(ctx.body.code); }
    catch (error) {
      return bad(`bind phone failed: ${error instanceof HttpException ? error.message : 'getuserphonenumber failed'}`);
    }
    try {
      if (user.tel !== phone.phoneNumber) user = await db.update('user', user.id, { tel: phone.phoneNumber });
      user = await auth.role(user);
    } catch {
      return bad('bind phone failed: Failed to save phone number');
    }
    return success({ user: userFields(user), phone: phone.phoneNumber, purePhone: phone.purePhoneNumber ?? null, countryCode: phone.countryCode ?? null });
  });
  router.add('POST', '/v1/we-chat/openid', async ctx => {
    const identity = await api.codeSession(ctx.body.code);
    return { openid: identity.openid, unionid: identity.unionid || null, success: true, message: identity.unionid ? 'success' : 'unionid not available (check if user has authorized or follows related official account)' };
  });
  // The PHP info action returned an SDK application instance, not a usable wire contract.
  // Only public identifiers are exposed; secrets, signing keys and SDK internals stay private.
  router.add('GET', '/v1/we-chat/info', () => ({ app_id: api.config.appId ?? null, mch_id: api.config.mchId ?? null }));
  router.add('GET', '/v1/wechat-pay/info', () => api.config.appId ?? null);

  for (const version of ['v1', 'v2']) {
    const prefix = `/${version}/wechat-pay`;
    const authorize = async (ctx: Context) => { if (version === 'v2') await auth.bearer(ctx, 'v2-user'); };
    router.add('POST', `${prefix}/wxpay-order`, async ctx => {
      await authorize(ctx);
      const input = ctx.body;
      if (!nonempty(input.openid)) return { code: 400, message: '缺少openid参数' };
      if (!nonempty(input.out_trade_no)) return { code: 400, message: '缺少商户订单号参数' };
      if (!numeric(input.amount) || Number(input.amount) <= 0 || !Number.isSafeInteger(Math.trunc(Number(input.amount)))) return { code: 400, message: '金额参数不正确' };
      if (!/^[A-Za-z0-9_-]{6,32}$/.test(input.out_trade_no)) return { code: 400, message: '商户订单号格式不正确，要求6-32位字母数字或下划线' };
      try {
        // Both Yii versions generated the v1 callback from the current request.
        const notifyUrl = api.config.notifyUrl || `${issuer(ctx).replace(/\/$/, '')}/v1/wechat-pay/notify`;
        return { code: 0, data: await api.order({ ...input, amount: Math.trunc(Number(input.amount)) }, notifyUrl) };
      }
      catch { return { code: 500, message: '支付下单失败' }; }
    });
    router.add('GET', `${prefix}/wxpay-query-order-by-out-trade-no`, async ctx => {
      await authorize(ctx);
      if (!nonempty(ctx.query.out_trade_no)) return { code: 400, message: '缺少商户订单号参数' };
      try {
        const result = await api.payment('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(ctx.query.out_trade_no)}?mchid=${encodeURIComponent(api.config.mchId || '')}`);
        return { code: 0, message: '查询成功', data: { order_info: result, trade_state: result.trade_state ?? '', trade_state_desc: result.trade_state_desc ?? '' } };
      } catch { return { code: 500, message: '查询订单失败' }; }
    });
    router.add('GET', `${prefix}/wxpay-query-order-by-transaction-id`, async ctx => {
      await authorize(ctx);
      const id = ctx.query.transaction_id;
      if (!nonempty(id)) return { code: 400, message: '缺少微信支付订单号参数' };
      if (!/^\d{28}$/.test(id)) return { code: 400, message: '微信支付订单号格式不正确，应为28位数字' };
      try {
        const result = await api.payment('GET', `/v3/pay/transactions/id/${encodeURIComponent(id)}?mchid=${encodeURIComponent(api.config.mchId || '')}`);
        return { code: 0, message: '查询成功', data: { order_info: result, trade_state: result.trade_state ?? '', trade_state_desc: result.trade_state_desc ?? '', out_trade_no: result.out_trade_no ?? '', transaction_id: result.transaction_id ?? '', amount: result.amount?.total ?? 0, payer: result.payer ?? [], success_time: result.success_time ?? '' } };
      } catch (error) { return errorCode(error) === 404 ? { code: 404, message: '订单不存在', data: null } : { code: 500, message: '查询订单失败' }; }
    });
    router.add('POST', `${prefix}/wxpay-refund`, async ctx => {
      await authorize(ctx);
      const input = ctx.body;
      if (!nonempty(input.out_trade_no)) return { code: 400, message: '缺少商户订单号参数' };
      if (!nonempty(input.out_refund_no)) return { code: 400, message: '缺少商户退款单号参数' };
      if (!numeric(input.refund_amount) || Number(input.refund_amount) <= 0) return { code: 400, message: '退款金额参数不正确' };
      if (!numeric(input.total_amount) || Number(input.total_amount) <= 0) return { code: 400, message: '订单总金额参数不正确' };
      const refund = Math.trunc(Number(input.refund_amount)), total = Math.trunc(Number(input.total_amount));
      if (!Number.isSafeInteger(refund) || !Number.isSafeInteger(total)) return { code: 400, message: '退款金额参数不正确' };
      if (refund > total) return { code: 400, message: '退款金额不能大于订单总金额' };
      try {
        const result = await api.payment('POST', '/v3/refund/domestic/refunds', { out_trade_no: input.out_trade_no, out_refund_no: input.out_refund_no, reason: input.reason || '', ...(api.config.refundNotifyUrl ? { notify_url: api.config.refundNotifyUrl } : {}), amount: { refund, total, currency: 'CNY' } });
        return { code: 0, message: '退款申请成功', data: { refund_id: result.refund_id ?? '', out_refund_no: result.out_refund_no ?? '', status: result.status ?? '', refund_amount: result.amount?.refund ?? 0, success_time: result.success_time ?? '' } };
      } catch { return { code: 500, message: '申请退款失败' }; }
    });
    router.add('GET', `${prefix}/wxpay-query-refund`, async ctx => {
      await authorize(ctx);
      if (!nonempty(ctx.query.out_refund_no)) return { code: 400, message: '缺少商户退款单号参数' };
      try {
        const result = await api.payment('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(ctx.query.out_refund_no)}`);
        return { code: 0, message: '查询成功', data: { refund_info: result, refund_status: result.status ?? '', refund_amount: result.amount?.refund ?? 0, success_time: result.success_time ?? '' } };
      } catch { return { code: 500, message: '查询退款失败' }; }
    });
    const notify = (refund: boolean) => async (ctx: Context) => {
      // WeChat cannot supply a user Bearer. Platform RSA signature authenticates this route.
      const raw = (ctx.req as typeof ctx.req & { rawBody?: Buffer }).rawBody;
      const notice = await api.notification(raw ?? '', ctx.req.headers);
      if (typeof notice.id !== 'string' || !notice.id || typeof notice.event_type !== 'string'
        || (refund ? !notice.event_type.startsWith('REFUND.') : notice.event_type !== 'TRANSACTION.SUCCESS')) return bad('微信支付通知类型不匹配');
      // The source application has no payment-order persistence or fulfilment model.
      // Preserve its acknowledged-notification contract after authenticating/decrypting.
      if (api.config.onPaymentNotification) await api.config.onPaymentNotification(notice);
      return { code: 'SUCCESS', message: '成功' };
    };
    router.add(['POST', 'GET'], `${prefix}/notify`, notify(false));
    router.add('POST', `${prefix}/refund-notify`, notify(true));

    router.add('GET', `/${version}/tencent-cloud/cloud`, () => api.cloud());
    router.add('GET', `/${version}/tencent-cloud/store`, () => api.store());
    router.add('GET', `/${version}/tencent-cloud/token`, ctx => api.federationToken(ctx.query.bucket, ctx.query.region));
  }
  // Source QCloud action called an undefined File::Create. This repairs that broken
  // action with its documented signing operation; it does not manufacture file rows.
  router.add('GET', '/v1/q-cloud/object-url', async ctx => ({ url: await api.objectUrl(ctx.query.key, ctx.query), method: String(ctx.query.method || 'GET').toUpperCase(), expires: Number(ctx.query.expires ?? 900) }));
}
