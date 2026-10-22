import { describe, expect, it } from 'vitest';
import { createCipheriv, generateKeyPairSync, sign, verify } from 'node:crypto';
import { ApiRouter } from '../src/core/router';
import type { Context, Row, Services } from '../src/core/contracts';
import { Integrations, registerIntegrations } from '../src/integrations/integrations';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = 1800000000;
const appId = 'wx-test';
const config = { appId, appSecret: 'fake', mchId: 'merchant', serialNo: 'merchant-key', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), platformKeys: { 'platform-key': keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, apiV3Key: '12345678901234567890123456789012', notifyUrl: 'https://example.test/v1/wechat-pay/notify', refundNotifyUrl: 'https://example.test/v1/wechat-pay/refund-notify', now: () => now, nonce: () => 'nonce' };
function signedResponse(body: Row, status = 200) {
  const raw = JSON.stringify(body);
  return new Response(raw, { status, headers: { 'wechatpay-serial': 'platform-key', 'wechatpay-timestamp': String(now), 'wechatpay-nonce': 'response-nonce', 'wechatpay-signature': sign('RSA-SHA256', Buffer.from(`${now}\nresponse-nonce\n${raw}\n`), keys.privateKey).toString('base64') } });
}
function setup() {
  const requests: Array<{ url: URL; method: string; body?: Row }> = [];
  const api = new Integrations({ ...config, fetch: async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url.pathname.endsWith('jsapi')) return signedResponse({ prepay_id: 'prepay-id' });
    if (url.pathname.includes('missing')) return signedResponse({ code: 'ORDER_NOT_EXIST' }, 404);
    if (url.pathname.includes('/refund/')) return signedResponse({ refund_id: 'refund-id', out_refund_no: 'refund1', status: 'SUCCESS', amount: { refund: 50 }, success_time: 'time' });
    return signedResponse({ trade_state: 'SUCCESS', trade_state_desc: '支付成功', transaction_id: '1'.repeat(28), out_trade_no: 'order01', amount: { total: 100 }, payer: { openid: 'payer' }, success_time: 'time' });
  } });
  const router = new ApiRouter();
  const services = { integrations: api, auth: { bearer: async () => ({ id: 1 }) } } as unknown as Services;
  registerIntegrations(router, services);
  const call = async (method: string, path: string, body: Row = {}, query: Row = {}, rawBody = '', headers: Row = {}) => router.match(method, path)!.route.handler({ body, query, params: {}, req: { headers, rawBody: Buffer.from(rawBody) }, res: {} } as unknown as Context);
  return { requests, call };
}

describe('payment endpoints with cryptographic provider transport', () => {
  it('orders and queries through signed APIv3 and preserves v1/v2 response shape', async () => {
    const { requests, call } = setup();
    for (const version of ['v1', 'v2']) {
      const order: any = await call('POST', `/${version}/wechat-pay/wxpay-order`, { openid: 'payer', out_trade_no: 'order01', amount: 100 });
      expect(order.code).toBe(0);
      expect(order.data).toMatchObject({ appId, signType: 'RSA', package: 'prepay_id=prepay-id' });
      const miniSign = `${appId}\n${now}\nnonce\nprepay_id=prepay-id\n`;
      expect(verify('RSA-SHA256', Buffer.from(miniSign), keys.publicKey, Buffer.from(order.data.paySign, 'base64'))).toBe(true);
      expect(requests.at(-1)?.body).toMatchObject({ payer: { openid: 'payer' }, notify_url: config.notifyUrl, amount: { total: 100, currency: 'CNY' } });
      const query: any = await call('GET', `/${version}/wechat-pay/wxpay-query-order-by-out-trade-no`, {}, { out_trade_no: 'order01' });
      expect(query).toMatchObject({ code: 0, data: { trade_state: 'SUCCESS', order_info: { out_trade_no: 'order01' } } });
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
    const notice = (refund: boolean, merchant = 'merchant') => {
      const resource = refund ? { mchid: merchant, out_refund_no: 'refund1', refund_status: 'SUCCESS' } : { mchid: merchant, appid: appId, out_trade_no: 'order01', trade_state: 'SUCCESS' };
      const cipher = createCipheriv('aes-256-gcm', config.apiV3Key, Buffer.from('nonce-123456'));
      cipher.setAAD(Buffer.from('test'));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(resource)), cipher.final(), cipher.getAuthTag()]).toString('base64');
      const raw = JSON.stringify({ id: 'notice1', event_type: refund ? 'REFUND.SUCCESS' : 'TRANSACTION.SUCCESS', resource: { algorithm: 'AEAD_AES_256_GCM', nonce: 'nonce-123456', associated_data: 'test', ciphertext } });
      const headers = { 'wechatpay-serial': 'platform-key', 'wechatpay-timestamp': String(now), 'wechatpay-nonce': 'nonce', 'wechatpay-signature': sign('RSA-SHA256', Buffer.from(`${now}\nnonce\n${raw}\n`), keys.privateKey).toString('base64') };
      return { raw, headers };
    };
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
});
