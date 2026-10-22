import { describe, expect, it, vi } from 'vitest';
import { createCipheriv, generateKeyPairSync, sign, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ApiRouter } from '../src/core/router';
import type { Context, Row, Services } from '../src/core/contracts';
import { Integrations, registerIntegrations } from '../src/integrations/integrations';
import type { IntegrationOptions } from '../src/integrations/integrations';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = 1800000000;
const appId = 'wx-test';
const config = { appId, appSecret: 'fake', mchId: 'merchant', serialNo: 'merchant-key', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), platformKeys: { 'platform-key': keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, apiV3Key: '12345678901234567890123456789012', notifyUrl: 'https://example.test/v1/wechat-pay/notify', refundNotifyUrl: 'https://example.test/v1/wechat-pay/refund-notify', now: () => now, nonce: () => 'nonce' };
function signedResponse(body: Row, status = 200) {
  const raw = JSON.stringify(body);
  return new Response(raw, { status, headers: { 'wechatpay-serial': 'platform-key', 'wechatpay-timestamp': String(now), 'wechatpay-nonce': 'response-nonce', 'wechatpay-signature': sign('RSA-SHA256', Buffer.from(`${now}\nresponse-nonce\n${raw}\n`), keys.privateKey).toString('base64') } });
}
function setup(overrides: Partial<IntegrationOptions> = {}, reserved = true) {
  const requests: Array<{ url: URL; method: string; body?: Row }> = [];
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE user (id INTEGER PRIMARY KEY, openid TEXT, unionid TEXT, role TEXT);
    CREATE TABLE file (id INTEGER PRIMARY KEY, user_id INTEGER, unionid TEXT, price INTEGER, unlocked INTEGER, key TEXT);
    CREATE TABLE file_payment_order (out_trade_no TEXT PRIMARY KEY, user_id INTEGER NOT NULL, file_id INTEGER NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO user VALUES (7, 'payer', 'union', 'user');
    INSERT INTO file VALUES (1, 7, 'union', 100, 0, 'folder/movie.mp4'), (2, 8, 'other', 100, 0, 'other.mp4');`);
  if (reserved) sqlite.exec("INSERT INTO file_payment_order VALUES ('order01',7,1,100,'2026-01-01 00:00:00')");
  const db = {
    async one(sql: string, params: any[] = []) { return sqlite.prepare(sql).get(...params) ?? null; },
    async query(sql: string, params: any[] = []) { return sqlite.prepare(sql).all(...params); },
    async execute(sql: string, params: any[] = []) {
      try { const result = sqlite.prepare(sql).run(...params); return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }; }
      catch (error: any) { if ([1555, 2067].includes(error.errcode)) error.code = 'ER_DUP_ENTRY'; throw error; }
    },
  };
  const reservationsAtProvider: Array<Row | null> = [];
  const provider = { signed: true, orderFails: false, order: { appid: appId, mchid: 'merchant', trade_state: 'SUCCESS', trade_state_desc: '支付成功', transaction_id: '1'.repeat(28), out_trade_no: 'order01', amount: { total: 100, currency: 'CNY' }, payer: { openid: 'payer' }, success_time: 'time', attach: JSON.stringify({ v: 1, file_id: 1, user_id: 7, amount: 100 }) } as Row };
  const api = new Integrations({ ...config, ...overrides, fetch: async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url.pathname.endsWith('jsapi')) {
      reservationsAtProvider.push(await db.one('SELECT * FROM file_payment_order WHERE out_trade_no=?', [body!.out_trade_no]));
      return provider.orderFails ? signedResponse({ code: 'SYSTEM_ERROR' }, 503) : signedResponse({ prepay_id: 'prepay-id' });
    }
    if (url.pathname.includes('missing')) return signedResponse({ code: 'ORDER_NOT_EXIST' }, 404);
    if (url.pathname.includes('/refund/')) return signedResponse({ refund_id: 'refund-id', out_refund_no: 'refund1', status: 'SUCCESS', amount: { refund: 50 }, success_time: 'time' });
    return provider.signed ? signedResponse(provider.order) : Response.json(provider.order);
  } });
  const router = new ApiRouter();
  const services = { db, integrations: api, auth: { bearer: async () => ({ id: 7, openid: 'payer', unionid: 'union' }) } } as unknown as Services;
  registerIntegrations(router, services);
  const responseStatuses: number[] = [];
  const res = { status(status: number) { responseStatuses.push(status); return res; } };
  const call = async (method: string, path: string, body: Row = {}, query: Row = {}, rawBody = '', headers: Row = {}) => router.match(method, path)!.route.handler({ body, query, params: {}, req: { headers, rawBody: Buffer.from(rawBody), protocol: 'https', get: () => 'legacy.example.test' }, res } as unknown as Context);
  const file = () => db.one('SELECT * FROM file WHERE id = ?', [1]);
  return { requests, call, provider, db, file, responseStatuses, reservationsAtProvider };
}

function notice(refund = false, merchant = 'merchant') {
  const resource = refund ? { mchid: merchant, out_refund_no: 'refund1', refund_status: 'SUCCESS' } : { mchid: merchant, appid: appId, out_trade_no: 'order01', trade_state: 'SUCCESS' };
  const cipher = createCipheriv('aes-256-gcm', config.apiV3Key, Buffer.from('nonce-123456'));
  cipher.setAAD(Buffer.from('test'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(resource)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const raw = JSON.stringify({ id: 'notice1', event_type: refund ? 'REFUND.SUCCESS' : 'TRANSACTION.SUCCESS', resource: { algorithm: 'AEAD_AES_256_GCM', nonce: 'nonce-123456', associated_data: 'test', ciphertext } });
  const headers = { 'wechatpay-serial': 'platform-key', 'wechatpay-timestamp': String(now), 'wechatpay-nonce': 'nonce', 'wechatpay-signature': sign('RSA-SHA256', Buffer.from(`${now}\nnonce\n${raw}\n`), keys.privateKey).toString('base64') };
  return { raw, headers };
}

describe('payment endpoints with cryptographic provider transport', () => {
  it('derives the original callback from the request when no new URL configuration is supplied', async () => {
    try {
      vi.stubEnv('PUBLIC_ORIGIN', undefined);
      vi.stubEnv('WECHAT_PAY_NOTIFY_URL', undefined);
      const { requests, call } = setup({ notifyUrl: undefined });
      for (const version of ['v1', 'v2']) {
        expect(await call('POST', `/${version}/wechat-pay/wxpay-order`, { file_id: 1, openid: 'payer', out_trade_no: 'order01', amount: 100 })).toMatchObject({ code: 0 });
        expect(requests.at(-1)?.body?.notify_url).toBe(`https://legacy.example.test/${version}/wechat-pay/notify`);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it('prefers the configured public origin over the incoming request origin for callback URLs', async () => {
    try {
      vi.stubEnv('PUBLIC_ORIGIN', 'https://public.example.test/');
      vi.stubEnv('WECHAT_PAY_NOTIFY_URL', undefined);
      // Use the actual environment parser, so PUBLIC_ORIGIN cannot become a
      // fixed override that sends v1 ordinary orders to the v2 file callback.
      const { requests, call } = setup({ notifyUrl: new Integrations().config.notifyUrl });
      for (const version of ['v1', 'v2']) {
        expect(await call('POST', `/${version}/wechat-pay/wxpay-order`, { file_id: 1, openid: 'payer', out_trade_no: 'order01', amount: 100 })).toMatchObject({ code: 0 });
        expect(requests.at(-1)?.body?.notify_url).toBe(`https://public.example.test/${version}/wechat-pay/notify`);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it('orders and queries through signed APIv3 and preserves v1/v2 response shape', async () => {
    const { requests, call } = setup();
    for (const version of ['v1', 'v2']) {
      const order: any = await call('POST', `/${version}/wechat-pay/wxpay-order`, { file_id: 1, openid: 'payer', out_trade_no: 'order01', amount: 100 });
      expect(order.code).toBe(0);
      expect(order.data).toMatchObject({ appId, signType: 'RSA', package: 'prepay_id=prepay-id' });
      const miniSign = `${appId}\n${now}\nnonce\nprepay_id=prepay-id\n`;
      expect(verify('RSA-SHA256', Buffer.from(miniSign), keys.publicKey, Buffer.from(order.data.paySign, 'base64'))).toBe(true);
      expect(requests.at(-1)?.body).toMatchObject({ payer: { openid: 'payer' }, notify_url: config.notifyUrl, amount: { total: 100, currency: 'CNY' } });
      const query: any = await call('GET', `/${version}/wechat-pay/wxpay-query-order-by-out-trade-no`, {}, { out_trade_no: 'order01' });
      expect(query).toMatchObject({ code: 0, data: { trade_state: 'SUCCESS', order_info: { out_trade_no: 'order01' } } });
      if (version === 'v2') expect(query.data.unlocked).toBe(true);
      else expect(query.data).not.toHaveProperty('unlocked');
      expect(requests.at(-1)?.url.searchParams.get('mchid')).toBe('merchant');
      const transaction: any = await call('GET', `/${version}/wechat-pay/wxpay-query-order-by-transaction-id`, {}, { transaction_id: '1'.repeat(28) });
      expect(transaction).toMatchObject({ code: 0, data: { amount: 100, payer: { openid: 'payer' }, transaction_id: '1'.repeat(28) } });
    }
  });
  it('submits and queries refunds with integer fen and configured notification URL', async () => {
    const { requests, call } = setup();
    for (const version of ['v1', 'v2']) {
      expect(await call('POST', `/${version}/wechat-pay/wxpay-refund`, { out_trade_no: 'order01', out_refund_no: 'refund1', refund_amount: 50, total_amount: 100 })).toMatchObject({ code: 0, data: { refund_id: 'refund-id', refund_amount: 50, status: 'SUCCESS' } });
      expect(requests.at(-1)?.body).toMatchObject({ amount: { refund: 50, total: 100, currency: 'CNY' }, notify_url: config.refundNotifyUrl });
      expect(await call('GET', `/${version}/wechat-pay/wxpay-query-refund`, {}, { out_refund_no: 'refund1' })).toMatchObject({ code: 0, data: { refund_status: 'SUCCESS', refund_amount: 50, refund_info: { refund_id: 'refund-id' } } });
    }
  });
  it('authenticates raw payment and refund notifications, rejects cross-endpoint events and merchant mismatch', async () => {
    const { call } = setup();
    for (const version of ['v1', 'v2']) {
      const paid = notice(false), refund = notice(true);
      expect(await call('POST', `/${version}/wechat-pay/notify`, {}, {}, paid.raw, paid.headers)).toEqual({ code: 'SUCCESS', message: '成功' });
      expect(await call('POST', `/${version}/wechat-pay/refund-notify`, {}, {}, refund.raw, refund.headers)).toEqual({ code: 'SUCCESS', message: '成功' });
      await expect(call('POST', `/${version}/wechat-pay/refund-notify`, {}, {}, paid.raw, paid.headers)).rejects.toThrow('类型不匹配');
      const wrongMerchant = notice(false, 'attacker');
      await expect(call('POST', `/${version}/wechat-pay/notify`, {}, {}, wrongMerchant.raw, wrongMerchant.headers)).rejects.toThrow('商户身份不匹配');
    }
  });
  it('rejects boolean amounts before contacting the payment provider', async () => {
    const { requests, call } = setup();
    expect(await call('POST', '/v1/wechat-pay/wxpay-order', { openid: 'payer', out_trade_no: 'order01', amount: true })).toMatchObject({ code: 400 });
    expect(requests).toHaveLength(0);
  });

  it('builds v2 file orders from the owned price snapshot and current verified payer', async () => {
    const f = setup();
    expect(await f.call('POST', '/v2/wechat-pay/wxpay-order', { file_id: 1, out_trade_no: 'order01', description: 'client description', attach: 'client attachment', unlocked: 1 })).toMatchObject({ code: 0 });
    const order = f.requests.at(-1)!.body!;
    expect(order).toMatchObject({ amount: { total: 100, currency: 'CNY' }, payer: { openid: 'payer' }, description: 'AR打卡服务:movie.mp4' });
    expect(JSON.parse(order.attach)).toEqual({ v: 1, file_id: 1, user_id: 7, amount: 100 });
    expect((await f.file())!.unlocked).toBe(0);
  });

  it('bounds server-generated file descriptions by UTF-8 bytes without splitting a character', async () => {
    const f = setup();
    await f.db.execute('UPDATE file SET key = ? WHERE id = ?', [`folder/${'长'.repeat(100)}.mp4`, 1]);
    expect(await f.call('POST', '/v2/wechat-pay/wxpay-order', { file_id: 1, out_trade_no: 'order01' })).toMatchObject({ code: 0 });
    expect(f.requests.at(-1)!.body!.description).toBe(`AR打卡服务:${'长'.repeat(35)}`);
  });

  it('rejects missing or foreign files and client payment mismatches before contacting WeChat', async () => {
    for (const [body, status, message] of [
      [{ out_trade_no: 'bad' }, 400, '商户订单号格式不正确'],
      [{ out_trade_no: 'order01' }, 400, '文件编号无效'],
      [{ file_id: 2, out_trade_no: 'order01' }, 404, '文件不存在或不属于当前账号'],
      [{ file_id: 1, out_trade_no: 'order01', amount: 99 }, 400, '文件金额已更新，请刷新后重试'],
      [{ file_id: 1, out_trade_no: 'order01', amount: false }, 400, '文件金额已更新，请刷新后重试'],
      [{ file_id: 1, out_trade_no: 'order01', openid: 'other-payer' }, 400, '付款账号与当前登录账号不一致'],
    ] as Array<[Row, number, string]>) {
      const f = setup();
      await expect(f.call('POST', '/v2/wechat-pay/wxpay-order', body)).rejects.toMatchObject({ status, message });
      expect(f.requests).toHaveLength(0);
      expect((await f.file())!.unlocked).toBe(0);
    }
  });

  it('refuses unknown, free and already unlocked file prices without creating duplicate payments', async () => {
    for (const [price, unlocked, status] of [[null, 0, 422], [0, 0, 409], [100, 1, 409]]) {
      const f = setup();
      await f.db.execute('UPDATE file SET price = ?, unlocked = ? WHERE id = ?', [price, unlocked, 1]);
      await expect(f.call('POST', '/v2/wechat-pay/wxpay-order', { file_id: 1, out_trade_no: 'order01' })).rejects.toMatchObject({ status });
      expect(f.requests).toHaveLength(0);
    }
  });

  it('unlocks a file only after an authenticated matching successful order query and remains idempotent', async () => {
    const f = setup();
    f.provider.order.trade_state = 'NOTPAY';
    expect(await f.call('GET', '/v2/wechat-pay/wxpay-query-order-by-out-trade-no', {}, { out_trade_no: 'order01' })).toMatchObject({ code: 0, data: { unlocked: false } });
    expect((await f.file())!.unlocked).toBe(0);
    f.provider.order.trade_state = 'SUCCESS';
    for (let count = 0; count < 2; count++) {
      expect(await f.call('GET', '/v2/wechat-pay/wxpay-query-order-by-out-trade-no', {}, { out_trade_no: 'order01' })).toMatchObject({ code: 0, data: { unlocked: true } });
      expect((await f.file())!.unlocked).toBe(1);
    }
  });

  it('rejects forged query ownership, amounts and payment identities without unlocking', async () => {
    for (const patch of [
      { out_trade_no: 'different-order' }, { appid: 'other-app' }, { mchid: 'other-merchant' },
      { payer: { openid: 'other-payer' } }, { amount: { total: 99, currency: 'CNY' } },
      { amount: { total: 100, currency: 'USD' } }, { attach: '{}' },
      { attach: JSON.stringify({ v: 1, file_id: 1, user_id: 8, amount: 100 }) },
      { attach: JSON.stringify({ v: 1, file_id: 2, user_id: 7, amount: 100 }) },
      { attach: JSON.stringify({ v: 1, file_id: 1, user_id: 7, amount: 99 }) },
    ]) {
      const f = setup(); Object.assign(f.provider.order, patch);
      await expect(f.call('GET', '/v2/wechat-pay/wxpay-query-order-by-out-trade-no', {}, { out_trade_no: 'order01' })).rejects.toMatchObject({ status: 403 });
      expect((await f.file())!.unlocked).toBe(0);
    }
    const f = setup();
    await expect(f.call('GET', '/v2/wechat-pay/wxpay-query-order-by-out-trade-no', {}, { out_trade_no: 'bad' })).rejects.toMatchObject({ status: 400, message: '订单编号无效' });
    expect(f.requests).toHaveLength(0);
  });

  it('requeries WeChat after an authentic v2 callback and ignores callback success until the queried order succeeds', async () => {
    const f = setup(); const paid = notice();
    f.provider.order.trade_state = 'NOTPAY';
    expect(await f.call('POST', '/v2/wechat-pay/notify', {}, {}, paid.raw, paid.headers)).toEqual({ code: 'SUCCESS', message: '成功' });
    expect(f.requests.at(-1)?.url.pathname).toBe('/v3/pay/transactions/out-trade-no/order01');
    expect((await f.file())!.unlocked).toBe(0);
    f.provider.order.trade_state = 'SUCCESS';
    expect(await f.call('POST', '/v2/wechat-pay/notify', {}, {}, paid.raw, paid.headers)).toEqual({ code: 'SUCCESS', message: '成功' });
    expect((await f.file())!.unlocked).toBe(1);
  });

  it('does not acknowledge or unlock a callback whose authenticated order fails the file checks', async () => {
    const f = setup(); const paid = notice();
    f.provider.order.amount.total = 1;
    expect(await f.call('POST', '/v2/wechat-pay/notify', {}, {}, paid.raw, paid.headers)).toMatchObject({ code: 'ERROR' });
    expect(f.responseStatuses.at(-1)).toBe(500);
    expect((await f.file())!.unlocked).toBe(0);
  });

  it('verifies callback signatures before querying an order or changing file access', async () => {
    const f = setup(); const paid = notice();
    await expect(f.call('POST', '/v2/wechat-pay/notify', {}, {}, paid.raw + ' ', paid.headers)).rejects.toThrow('签名');
    expect(f.requests).toHaveLength(0);
    expect((await f.file())!.unlocked).toBe(0);
  });

  it('rejects unsigned provider query responses before granting file access in either query or callback paths', async () => {
    const f = setup(); const paid = notice(); f.provider.signed = false;
    expect(await f.call('GET', '/v2/wechat-pay/wxpay-query-order-by-out-trade-no', {}, { out_trade_no: 'order01' })).toMatchObject({ code: 500 });
    expect((await f.file())!.unlocked).toBe(0);
    expect(await f.call('POST', '/v2/wechat-pay/notify', {}, {}, paid.raw, paid.headers)).toMatchObject({ code: 'ERROR' });
    expect(f.responseStatuses.at(-1)).toBe(500);
    expect((await f.file())!.unlocked).toBe(0);
  });

  it('rejects callback orders whose bound account no longer exists', async () => {
    const f = setup(); const paid = notice();
    await f.db.execute('DELETE FROM user WHERE id=?', [7]);
    expect(await f.call('POST', '/v2/wechat-pay/notify', {}, {}, paid.raw, paid.headers)).toEqual({ code: 'ERROR', message: '订单账号不存在' });
    expect(f.responseStatuses.at(-1)).toBe(500);
    expect((await f.file())!.unlocked).toBe(0);
  });

  it('reserves the local binding before contacting WeChat and keeps failed order retries on that binding', async () => {
    const f = setup({}, false); f.provider.orderFails = true;
    expect(await f.call('POST', '/v2/wechat-pay/wxpay-order', { file_id: 1, out_trade_no: 'order01' })).toMatchObject({ code: 500 });
    expect(f.reservationsAtProvider[0]).toMatchObject({ out_trade_no: 'order01', user_id: 7, file_id: 1, amount: 100 });
    f.provider.orderFails = false;
    expect(await f.call('POST', '/v2/wechat-pay/wxpay-order', { file_id: 1, out_trade_no: 'order01' })).toMatchObject({ code: 0 });
    expect(f.reservationsAtProvider[1]).toEqual(f.reservationsAtProvider[0]);
    await f.db.execute('INSERT INTO file VALUES (?,?,?,?,?,?)', [5, 7, 'union', 100, 0, 'other-owned.mp4']);
    const requestCount = f.requests.length;
    await expect(f.call('POST', '/v2/wechat-pay/wxpay-order', { file_id: 5, out_trade_no: 'order01' })).rejects.toMatchObject({ status: 409 });
    expect(f.requests).toHaveLength(requestCount);
  });

  it('rejects unknown and foreign local order numbers before querying WeChat', async () => {
    for (const userId of [null, 8]) {
      const f = setup();
      if (userId === null) await f.db.execute('DELETE FROM file_payment_order');
      else await f.db.execute('UPDATE file_payment_order SET user_id=?', [userId]);
      await expect(f.call('GET', '/v2/wechat-pay/wxpay-query-order-by-out-trade-no', {}, { out_trade_no: 'order01' })).rejects.toMatchObject({ status: 403, message: '订单不存在或不属于当前账号' });
      expect(f.requests).toHaveLength(0);
    }
  });

  it('returns unlocked false for known unpaid states whose signed API result omits payment details', async () => {
    const f = setup();
    for (const trade_state of ['NOTPAY', 'CLOSED', 'REVOKED', 'USERPAYING', 'PAYERROR', 'REFUND']) {
      f.provider.order = { appid: appId, mchid: 'merchant', out_trade_no: 'order01', trade_state };
      expect(await f.call('GET', '/v2/wechat-pay/wxpay-query-order-by-out-trade-no', {}, { out_trade_no: 'order01' })).toMatchObject({ code: 0, data: { unlocked: false } });
      expect((await f.file())!.unlocked).toBe(0);
    }
    f.provider.order.trade_state = 'UNKNOWN';
    await expect(f.call('GET', '/v2/wechat-pay/wxpay-query-order-by-out-trade-no', {}, { out_trade_no: 'order01' })).rejects.toMatchObject({ status: 403, message: '订单支付状态无效' });
  });

  it('resolves callback users from the local reservation before querying WeChat, independently of attach', async () => {
    const f = setup(); const paid = notice();
    f.provider.order = { appid: appId, mchid: 'merchant', out_trade_no: 'order01', trade_state: 'NOTPAY', attach: '{"user_id":999}' };
    expect(await f.call('POST', '/v2/wechat-pay/notify', {}, {}, paid.raw, paid.headers)).toEqual({ code: 'SUCCESS', message: '成功' });
    expect((await f.file())!.unlocked).toBe(0);
    f.provider.order.out_trade_no = 'different-order';
    expect(await f.call('POST', '/v2/wechat-pay/notify', {}, {}, paid.raw, paid.headers)).toEqual({ code: 'ERROR', message: '查询订单编号不一致' });
    const requests = f.requests.length;
    await f.db.execute('DELETE FROM file_payment_order');
    expect(await f.call('POST', '/v2/wechat-pay/notify', {}, {}, paid.raw, paid.headers)).toEqual({ code: 'ERROR', message: '订单账号不存在' });
    expect(f.requests).toHaveLength(requests);
  });
});
