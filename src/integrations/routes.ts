import { HttpException } from '@nestjs/common';
import { basename } from 'node:path';
import type { Context, Row, Services } from '../core/contracts';
import type { ApiRouter } from '../core/router';
import { ApiError } from '../core/errors';
import { yiiObject } from '../core/serialization';
import { MiniProgramFileService } from '../v2/file-service';

const success = (data: unknown, message = 'success') => ({ success: true, message, data });
const userFields = (row: Row) => Object.fromEntries(['id', 'tel', 'nickname', 'avatar', 'role'].map(name => [name, row[name] ?? null]));
function bad(message: string, status = 400, yiiType = 'HttpException'): never { throw Object.assign(new HttpException(message, status), { yiiType }); }
function issuer(ctx: Context): string {
  return process.env.PUBLIC_ORIGIN || `${ctx.req.protocol}://${ctx.req.get('host')}`;
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function phpEmpty(value: unknown): boolean { return value == null || value === false || value === 0 || value === '' || value === '0' || Array.isArray(value) && value.length === 0; }
function numeric(value: unknown): boolean {
  return (typeof value === 'number' || typeof value === 'string' && value.trim() !== '' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim())) && Number.isFinite(Number(value));
}
function errorCode(error: unknown): number { return error instanceof HttpException ? error.getStatus() : Number((error as Row)?.status || 500); }
function fileDescription(key: unknown): string {
  let description = '';
  for (const character of `AR打卡服务:${basename(String(key ?? ''))}`) {
    if (Buffer.byteLength(description + character, 'utf8') > 120) break;
    description += character;
  }
  return description;
}

export function registerIntegrations(router: ApiRouter, services: Services): void {
  const { db, auth, integrations: api } = services;
  const files = new MiniProgramFileService(db);
  router.add('POST', '/v2/site/login', async ctx => {
    const identity = await api.codeSession(ctx.body.code);
    const unionid = nonempty(identity.unionid) ? identity.unionid : null;
    let user: Row | null;
    if (unionid) {
      user = await db.one('SELECT * FROM `user` WHERE unionid=? LIMIT 1', [unionid]);
      if (!user) {
        if ([...unionid].length > 255 || typeof identity.openid !== 'string' || [...identity.openid].length > 255) return bad('微信账号登录失败', 401, 'UnauthorizedHttpException');
        user = await db.insert('user', { openid: identity.openid, unionid, role: 'user' });
      }
    } else user = await db.one('SELECT * FROM `user` WHERE openid=? LIMIT 1', [identity.openid]);
    if (!user) return bad('微信账号尚未关联，请先完成账号授权', 401, 'UnauthorizedHttpException');
    user = await auth.role(user);
    return success({ token: auth.issue(user, 'v2-user', issuer(ctx)), user: userFields(user), openid: user.openid, unionid: user.unionid ?? null }, unionid ? 'success' : 'unionid not available (check if user has authorized or follows related official account)');
  });
  router.add('POST', '/v2/site/refresh-token', async ctx => {
    if (!nonempty(ctx.body.refreshToken)) return bad('Invalid or expired refreshToken', 401, 'UnauthorizedHttpException');
    return success({ token: await auth.refresh(ctx.body.refreshToken, 'v2-user', issuer(ctx)) }, 'refresh success');
  });
  router.add('POST', '/v2/wechat/profile', async ctx => {
    let user = await auth.bearer(ctx, 'v2-user');
    const patch: Row = {};
    for (const field of ['avatar', 'nickname']) {
      if (phpEmpty(ctx.body[field])) continue;
      if (typeof ctx.body[field] !== 'string' || [...ctx.body[field]].length > 255) return bad('Failed to save user profile', 500);
      if (ctx.body[field] !== user[field]) patch[field] = ctx.body[field];
    }
    if (Object.keys(patch).length) user = await db.update('user', user.id, patch);
    return success({ user: userFields(user) }, 'Profile updated successfully');
  });
  router.add('POST', '/v2/wechat/bind-phone', async ctx => {
    let user = await auth.bearer(ctx, 'v2-user');
    if (phpEmpty(ctx.body.code)) return bad('code parameter is required', 400, 'BadRequestHttpException');
    let phone: Row;
    try { phone = await api.phone(ctx.body.code); }
    catch (error) {
      return bad(`bind phone failed: ${error instanceof HttpException ? error.message : 'getuserphonenumber failed'}`, 400, 'BadRequestHttpException');
    }
    try {
      if (user.tel !== phone.phoneNumber) user = await db.update('user', user.id, { tel: phone.phoneNumber });
      user = await auth.role(user);
    } catch {
      return bad('bind phone failed: Failed to save phone number', 400, 'BadRequestHttpException');
    }
    return success({ user: userFields(user), phone: phone.phoneNumber, purePhone: phone.purePhoneNumber ?? null, countryCode: phone.countryCode ?? null });
  });
  router.add('POST', '/v1/we-chat/openid', async ctx => {
    const identity = await api.codeSession(ctx.body.code);
    return { openid: identity.openid, unionid: identity.unionid || null, success: true, message: identity.unionid ? 'success' : 'unionid not available (check if user has authorized or follows related official account)' };
  });
  // Yii serializes the SDK application instance with no public fields.
  router.add('GET', '/v1/we-chat/info', () => yiiObject('Application', {}));
  router.add('GET', '/v1/wechat-pay/info', () => api.config.appId ?? false);

  for (const version of ['v1', 'v2']) {
    const prefix = `/${version}/wechat-pay`;
    const authorize = async (ctx: Context) => version === 'v2' ? auth.bearer(ctx, 'v2-user') : null;
    router.add('POST', `${prefix}/wxpay-order`, async ctx => {
      const user = await authorize(ctx);
      ctx.res.setHeader('Content-Type', 'application/json; charset=UTF-8');
      const input = ctx.body;
      let order: Row;
      if (version === 'v2') {
        if (!nonempty(input.out_trade_no) || !/^[A-Za-z0-9_-]{6,32}$/.test(input.out_trade_no)) return bad('商户订单号格式不正确');
        const file = await files.findOwned(input.file_id, user!);
        order = { ...await files.reserveOrder(input.out_trade_no, file, user!, input.amount ?? null, input.openid ?? null), out_trade_no: input.out_trade_no, description: fileDescription(file.key) };
      } else {
        if (!nonempty(input.openid)) return { code: 400, message: '缺少openid参数' };
        if (!nonempty(input.out_trade_no)) return { code: 400, message: '缺少商户订单号参数' };
        if (!numeric(input.amount) || Number(input.amount) <= 0 || !Number.isSafeInteger(Math.trunc(Number(input.amount)))) return { code: 400, message: '金额参数不正确' };
        if (!/^[A-Za-z0-9_-]{6,32}$/.test(input.out_trade_no)) return { code: 400, message: '商户订单号格式不正确，要求6-32位字母数字或下划线' };
        order = { openid: input.openid, out_trade_no: input.out_trade_no, amount: Math.trunc(Number(input.amount)), description: input.description };
      }
      try {
        const notifyUrl = api.config.notifyUrl || `${issuer(ctx).replace(/\/$/, '')}${prefix}/notify`;
        return { code: 0, data: await api.order(order, notifyUrl) };
      }
      catch { return { code: 500, message: '支付下单失败' }; }
    });
    router.add('GET', `${prefix}/wxpay-query-order-by-out-trade-no`, async ctx => {
      const user = await authorize(ctx);
      ctx.res.setHeader('Content-Type', 'application/json; charset=UTF-8');
      if (version === 'v2' && (!nonempty(ctx.query.out_trade_no) || !/^[A-Za-z0-9_-]{6,32}$/.test(ctx.query.out_trade_no))) return bad('订单编号无效');
      if (!nonempty(ctx.query.out_trade_no)) return { code: 400, message: '缺少商户订单号参数' };
      if (version === 'v2') await files.assertOrderOwner(ctx.query.out_trade_no, user!);
      let result: Row;
      try {
        result = await api.payment('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(ctx.query.out_trade_no)}?mchid=${encodeURIComponent(api.config.mchId || '')}`);
      } catch { return { code: 500, message: '查询订单失败' }; }
      const data: Row = { order_info: result, trade_state: result.trade_state ?? '', trade_state_desc: result.trade_state_desc ?? '' };
      if (version === 'v2') {
        if (result.out_trade_no !== ctx.query.out_trade_no) return bad('查询订单编号不一致', 403);
        data.unlocked = await files.confirmPayment(result, user!, api.config.appId || '', api.config.mchId || '');
      }
      return { code: 0, message: '查询成功', data };
    });
    router.add('GET', `${prefix}/wxpay-query-order-by-transaction-id`, async ctx => {
      await authorize(ctx);
      ctx.res.setHeader('Content-Type', 'application/json; charset=UTF-8');
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
      ctx.res.setHeader('Content-Type', 'application/json; charset=UTF-8');
      const input = ctx.body;
      if (!nonempty(input.out_trade_no)) return { code: 400, message: '缺少商户订单号参数' };
      if (!nonempty(input.out_refund_no)) return { code: 400, message: '缺少商户退款单号参数' };
      if (!numeric(input.refund_amount) || Number(input.refund_amount) <= 0) return { code: 400, message: '退款金额参数不正确' };
      if (!numeric(input.total_amount) || Number(input.total_amount) <= 0) return { code: 400, message: '订单总金额参数不正确' };
      const refund = Math.trunc(Number(input.refund_amount)), total = Math.trunc(Number(input.total_amount));
      if (!Number.isSafeInteger(refund) || !Number.isSafeInteger(total)) return { code: 400, message: '退款金额参数不正确' };
      if (refund > total) return { code: 400, message: '退款金额不能大于订单总金额' };
      try {
        const result = await api.payment('POST', '/v3/refund/domestic/refunds', { out_trade_no: input.out_trade_no, out_refund_no: input.out_refund_no, reason: input.reason === undefined ? '' : input.reason, ...(api.config.refundNotifyUrl ? { notify_url: api.config.refundNotifyUrl } : {}), amount: { refund, total, currency: 'CNY' } });
        return { code: 0, message: '退款申请成功', data: { refund_id: result.refund_id ?? '', out_refund_no: result.out_refund_no ?? '', status: result.status ?? '', refund_amount: result.amount?.refund ?? 0, success_time: result.success_time ?? '' } };
      } catch { return { code: 500, message: '申请退款失败' }; }
    });
    router.add('GET', `${prefix}/wxpay-query-refund`, async ctx => {
      await authorize(ctx);
      ctx.res.setHeader('Content-Type', 'application/json; charset=UTF-8');
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
      if (version === 'v2' && !refund && notice.resource?.trade_state === 'SUCCESS') {
        try {
          const orderNo = notice.resource.out_trade_no;
          if (!nonempty(orderNo) || !/^[A-Za-z0-9_-]{6,32}$/.test(orderNo)) return bad('订单编号无效');
          const user = await files.findOrderUser(orderNo);
          // A signed notification triggers a fresh authenticated provider query;
          // its callback payload alone never grants access to a file.
          const order = await api.payment('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(api.config.mchId || '')}`);
          if (order.out_trade_no !== orderNo) return bad('查询订单编号不一致', 403);
          if (!await files.confirmPayment(order, user, api.config.appId || '', api.config.mchId || '')) return bad('支付结果尚未确认，请重试通知', 409);
        } catch (error) {
          // EasyWeChat Server::serve catches paid-handler failures before the
          // controller's outer exception boundary and emits its retry envelope.
          ctx.res.status(500);
          ctx.res.setHeader('Content-Type', 'application/json; charset=UTF-8');
          return { code: 'ERROR', message: error instanceof HttpException || error instanceof ApiError ? error.message : '支付通知处理异常' };
        }
      }
      if (api.config.onPaymentNotification) await api.config.onPaymentNotification(notice);
      if (version === 'v1' || refund) return yiiObject('Server', {});
      ctx.res.setHeader('Content-Type', 'application/json; charset=UTF-8');
      return { code: 'SUCCESS', message: '成功' };
    };
    router.add(['POST', 'GET'], `${prefix}/notify`, notify(false));
    router.add('POST', `${prefix}/refund-notify`, notify(true));

    router.add('GET', `/${version}/tencent-cloud/cloud`, () => api.cloud());
    router.add('GET', `/${version}/tencent-cloud/store`, () => api.store());
    router.add('GET', `/${version}/tencent-cloud/token`, ctx => {
      if (version === 'v2') return api.federationToken();
      if (ctx.query.bucket === undefined) return bad('Missing required parameters: bucket', 400, 'BadRequestHttpException');
      if (Array.isArray(ctx.query.bucket) || typeof ctx.query.bucket === 'object') return bad('Invalid data received for parameter "bucket".', 400, 'BadRequestHttpException');
      const region = ctx.query.region === undefined ? 'ap-nanjing' : ctx.query.region;
      if (Array.isArray(region) || typeof region === 'object') return bad('Invalid data received for parameter "region".', 400, 'BadRequestHttpException');
      return api.federationToken(ctx.query.bucket, region);
    });
  }
  // Source QCloud action called an undefined File::Create. This repairs that broken
  // action with its documented signing operation; it does not manufacture file rows.
  router.add('GET', '/v1/q-cloud/object-url', async ctx => {
    if (ctx.query.key === undefined) return bad('Missing required parameters: key', 400, 'BadRequestHttpException');
    return { url: await api.objectUrl(ctx.query.key, ctx.query), method: String(ctx.query.method || 'GET').toUpperCase(), expires: Number(ctx.query.expires ?? 900) };
  });
}
