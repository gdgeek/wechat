import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { ApiRouter } from '../src/core/router';
import type { Context, Row, Services } from '../src/core/contracts';
import { Integrations, registerIntegrations } from '../src/integrations/integrations';

function setup(result: Row = { openid: 'provider-openid', unionid: 'provider-union' }) {
  const users: Row[] = [];
  const db = {
    one: vi.fn(async (sql: string, values: any[]) => users.find(user => user[sql.includes('unionid') ? 'unionid' : 'openid'] === values[0]) || null),
    insert: vi.fn(async (_table: string, data: Row) => { const user = { id: users.length + 1, role: 'user', ...data }; users.push(user); return user; }),
    update: vi.fn(async (_table: string, id: any, data: Row) => { const user = users.find(user => user.id === id)!; Object.assign(user, data); return user; }),
  };
  const auth = {
    role: async (row: Row) => row,
    issue: vi.fn(() => ({ accessToken: 'access', refreshToken: 'refresh', expires: '2026/01/01 00:00:00' })),
    refresh: vi.fn(async () => ({ accessToken: 'new-access', refreshToken: 'new-refresh', expires: '2026/01/01 00:00:00' })),
    bearer: vi.fn(async () => users[0] || { id: 1, nickname: 'nick', avatar: 'avatar', tel: null, role: 'user' }),
  };
  const integrations = new Integrations({ appId: 'wx-test', appSecret: 'test-secret', fetch: async () => Response.json(result) });
  const services = { db, auth, integrations } as unknown as Services;
  const router = new ApiRouter();
  registerIntegrations(router, services);
  const call = async (method: string, path: string, body: Row = {}, query: Row = {}) => {
    const context = { body, query, params: {}, req: { method, path, protocol: 'https', headers: { host: 'example.test' }, get: () => 'example.test' }, res: { setHeader: vi.fn(), status: vi.fn() } } as unknown as Context;
    const route = router.match(method, path);
    if (!route) throw Error(`missing ${method} ${path}`);
    return route.route.handler(context);
  };
  return { users, db, auth, integrations, router, call };
}

describe('integration route contracts', () => {
  it('v2 login only uses verified WeChat identity and returns the existing public user projection', async () => {
    const { call, db, auth } = setup();
    const response: any = await call('POST', '/v2/site/login', { code: 'code', openid: 'forged', unionid: 'forged' });
    expect(db.insert).toHaveBeenCalledWith('user', { openid: 'provider-openid', unionid: 'provider-union', role: 'user' });
    expect(response).toMatchObject({ success: true, data: { openid: 'provider-openid', unionid: 'provider-union', user: { id: 1, role: 'user' }, token: { accessToken: 'access' } } });
    expect(response.data.user.openid).toBeUndefined();
    expect(auth.issue).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'v2-user', 'https://example.test');
  });
  it('does not create a new user when unionid is absent, and refresh enforces the v2 identity domain', async () => {
    const { call, db, auth } = setup({ openid: 'known' });
    await expect(call('POST', '/v2/site/login', { code: 'code', unionid: 'fake' })).rejects.toBeInstanceOf(HttpException);
    expect(db.insert).not.toHaveBeenCalled();
    expect(await call('POST', '/v2/site/refresh-token', { refreshToken: 'refresh-token' })).toMatchObject({ success: true, message: 'refresh success' });
    expect(auth.refresh).toHaveBeenCalledWith('refresh-token', 'v2-user', 'https://example.test');
  });
  it('updates only public profile fields and binds the provider verified phone', async () => {
    const { call, users, integrations, db } = setup();
    users.push({ id: 1, openid: 'o', unionid: 'u', nickname: 'before', avatar: 'a', role: 'user' });
    expect(await call('POST', '/v2/wechat/profile', { nickname: 'after', role: 'root', unionid: 'forged' })).toMatchObject({ success: true, data: { user: { nickname: 'after', role: 'user' } } });
    expect(db.update).toHaveBeenCalledWith('user', 1, { nickname: 'after' });
    vi.spyOn(integrations, 'phone').mockResolvedValue({ phoneNumber: '8613800000000', purePhoneNumber: '13800000000', countryCode: '86' });
    expect(await call('POST', '/v2/wechat/bind-phone', { code: 'phone-code', tel: 'forged' })).toMatchObject({ data: { phone: '8613800000000', purePhone: '13800000000', countryCode: '86' } });
    expect(users[0].tel).toBe('8613800000000');
  });
  it('returns the legacy bad-request status when a verified phone is already bound', async () => {
    const { call, integrations, db } = setup();
    vi.spyOn(integrations, 'phone').mockResolvedValue({ phoneNumber: '8613800000000' });
    db.update.mockRejectedValueOnce(Object.assign(new Error('Duplicate entry from private user.tel index'), { code: 'ER_DUP_ENTRY', sqlState: '23000' }));
    await expect(call('POST', '/v2/wechat/bind-phone', { code: 'phone-code' })).rejects.toMatchObject({ status: 400, message: 'bind phone failed: Failed to save phone number' });
  });
  it('wraps provider failures in the legacy bind-phone bad-request response', async () => {
    const { call, integrations } = setup();
    const phone = vi.spyOn(integrations, 'phone');
    for (const [status, message] of [[400, '微信服务请求失败，请重新授权'], [503, '外部服务暂时不可用']] as const) {
      phone.mockRejectedValueOnce(new HttpException(message, status));
      await expect(call('POST', '/v2/wechat/bind-phone', { code: 'phone-code' })).rejects.toMatchObject({ status: 400, message: `bind phone failed: ${message}` });
    }
  });
  it('sanitizes unexpected phone persistence failures while retaining the legacy bad-request status', async () => {
    const { call, integrations, db } = setup();
    vi.spyOn(integrations, 'phone').mockResolvedValue({ phoneNumber: '8613800000000' });
    db.update.mockRejectedValueOnce(new Error('private database connection and SQL details'));
    await expect(call('POST', '/v2/wechat/bind-phone', { code: 'phone-code' })).rejects.toMatchObject({ status: 400, message: 'bind phone failed: Failed to save phone number' });
  });
  it('preserves the unwrapped missing-code error before requesting a phone', async () => {
    const { call, integrations } = setup();
    const phone = vi.spyOn(integrations, 'phone');
    await expect(call('POST', '/v2/wechat/bind-phone')).rejects.toMatchObject({ status: 400, message: 'code parameter is required' });
    expect(phone).not.toHaveBeenCalled();
  });
  it('registers every legacy payment endpoint and preserves code-based validation', async () => {
    const { call, router } = setup();
    for (const version of ['v1', 'v2']) {
      for (const [method, action] of [['POST', 'wxpay-order'], ['GET', 'wxpay-query-order-by-out-trade-no'], ['GET', 'wxpay-query-order-by-transaction-id'], ['POST', 'wxpay-refund'], ['GET', 'wxpay-query-refund'], ['POST', 'notify'], ['GET', 'notify'], ['POST', 'refund-notify']]) expect(router.match(method, `/${version}/wechat-pay/${action}`)).not.toBeNull();
      expect(await call('POST', `/${version}/wechat-pay/wxpay-order`)).toMatchObject({ code: 400, message: '缺少openid参数' });
      expect(await call('POST', `/${version}/wechat-pay/wxpay-refund`, { out_trade_no: 'order1', out_refund_no: 'refund1', refund_amount: 200, total_amount: 100 })).toMatchObject({ code: 400, message: '退款金额不能大于订单总金额' });
      expect(await call('GET', `/${version}/wechat-pay/wxpay-query-order-by-transaction-id`, {}, { transaction_id: 'invalid' })).toMatchObject({ code: 400 });
    }
  });
  it('requires bearer for v2 payment operations but accepts authentic callback without bearer', async () => {
    const { call, auth, integrations } = setup();
    vi.spyOn(integrations, 'notification').mockResolvedValue({ id: 'event', event_type: 'TRANSACTION.SUCCESS', resource: { mchid: 'merchant' } });
    expect(await call('POST', '/v2/wechat-pay/notify')).toEqual({ code: 'SUCCESS', message: '成功' });
    expect(auth.bearer).not.toHaveBeenCalled();
    await call('GET', '/v2/wechat-pay/wxpay-query-order-by-out-trade-no');
    expect(auth.bearer).toHaveBeenCalledWith(expect.anything(), 'v2-user');
  });
  it('preserves v1 openid unionid-null and exposes only public integration configuration', async () => {
    const { call } = setup({ openid: 'openid', session_key: 'private-key' });
    expect(await call('POST', '/v1/we-chat/openid', { code: 'code' })).toMatchObject({ openid: 'openid', unionid: null, success: true });
    expect(JSON.stringify(await call('GET', '/v1/we-chat/info'))).not.toContain('test-secret');
  });
});
