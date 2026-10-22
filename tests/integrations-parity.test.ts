import { describe, expect, it, vi } from 'vitest';
import { ApiRouter } from '../src/core/router';
import type { Context, Row, Services } from '../src/core/contracts';
import { Integrations, registerIntegrations } from '../src/integrations/integrations';
import { ApiError, errorPayload } from '../src/core/errors';

function fixture() {
  const db = { one: vi.fn(async () => null), insert: vi.fn(async (_table: string, row: Row) => ({ id: 1, ...row })), update: vi.fn(async (_table: string, id: unknown, row: Row) => ({ id, ...row })) };
  const auth = { bearer: vi.fn(async () => ({ id: 1, nickname: 'before', avatar: 'a', role: 'user' })), role: vi.fn(async row => row), issue: vi.fn(() => ({ accessToken: 'test' })) };
  const api = new Integrations({ appId: 'wx-test', appSecret: 'fake', bucket: 'configured-123', region: 'ap-shanghai', fetch: vi.fn() });
  const session = vi.spyOn(api, 'codeSession').mockResolvedValue({ openid: 'o', unionid: 'u' });
  const federation = vi.spyOn(api, 'federationToken').mockResolvedValue({ Credentials: {} });
  const router = new ApiRouter(); registerIntegrations(router, { db, auth, integrations: api } as unknown as Services);
  const res = { setHeader: vi.fn() };
  const call = async (method: string, path: string, body: Row = {}, query: Row = {}) => router.match(method, path)!.route.handler({ req: { protocol: 'https', get: () => 'example.test' }, res, body, query, params: {} } as unknown as Context);
  return { call, res, db, auth, api, session, federation };
}

describe('current Yii integration action binding and response contracts', () => {
  it('bounds login code by UTF-8 bytes before provider traffic', async () => {
    const fetcher = vi.fn();
    const api = new Integrations({ appId: 'test', appSecret: 'test', fetch: fetcher });
    await expect(api.codeSession('中'.repeat(342))).rejects.toMatchObject({ status: 400, message: 'code is required' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects the PHP-empty phone code without requesting the provider', async () => {
    const f = fixture(); const phone = vi.spyOn(f.api, 'phone');
    await expect(f.call('POST', '/v2/wechat/bind-phone', { code: '0' })).rejects.toMatchObject({ status: 400, message: 'code parameter is required' });
    expect(phone).not.toHaveBeenCalled();
  });
  it('retains generic versus named Yii HTTP exception classes', async () => {
    const f = fixture();
    const payload = async (call: Promise<unknown>) => { try { await call; throw Error('expected error'); } catch (error) { return errorPayload(error).body; } };
    expect(await payload(f.call('POST', '/v2/wechat/profile', { nickname: 12 }))).toMatchObject({ type: 'yii\\web\\HttpException' });
    expect(await payload(f.call('POST', '/v2/wechat-pay/wxpay-order'))).toMatchObject({ type: 'yii\\web\\HttpException' });
    expect(await payload(f.call('POST', '/v2/wechat/bind-phone'))).toMatchObject({ type: 'yii\\web\\BadRequestHttpException' });
    expect(await payload(f.call('GET', '/v1/tencent-cloud/token'))).toMatchObject({ type: 'yii\\web\\BadRequestHttpException' });
  });
  it('serializes the legacy SDK info object as an empty object and absent cloud values as false', async () => {
    const f = fixture();
    expect(await f.call('GET', '/v1/we-chat/info')).toEqual({});
    f.api.config.bucket = undefined; f.api.config.region = undefined;
    for (const version of ['v1', 'v2']) expect(await f.call('GET', `/${version}/tencent-cloud/cloud`)).toEqual({ bucket: false, region: false });
  });
  it('returns false for an unconfigured payment application identifier', async () => {
    const f = fixture(); f.api.config.appId = undefined;
    expect(await f.call('GET', '/v1/wechat-pay/info')).toBe(false);
  });
  it('binds required COS object key before inspecting provider configuration', async () => {
    const f = fixture();
    await expect(f.call('GET', '/v1/q-cloud/object-url')).rejects.toMatchObject({ status: 400, message: 'Missing required parameters: key' });
  });
  it('v2 token ignores caller bucket and region while v1 requires bucket and defaults its region', async () => {
    const f = fixture();
    await f.call('GET', '/v2/tencent-cloud/token', {}, { bucket: 'ignored-456', region: 'ignored-region' });
    expect(f.federation).toHaveBeenLastCalledWith();
    await expect(f.call('GET', '/v1/tencent-cloud/token')).rejects.toMatchObject({ status: 400, message: 'Missing required parameters: bucket' });
    await f.call('GET', '/v1/tencent-cloud/token', {}, { bucket: 'configured-123' });
    expect(f.federation).toHaveBeenLastCalledWith('configured-123', 'ap-nanjing');
  });
  it('profile ignores PHP-empty fields and reports invalid nonempty values as failed saves', async () => {
    const f = fixture();
    for (const nickname of [null, false, 0, '0', '', []]) {
      expect(await f.call('POST', '/v2/wechat/profile', { nickname })).toMatchObject({ success: true, data: { user: { nickname: 'before' } } });
    }
    expect(f.db.update).not.toHaveBeenCalled();
    for (const nickname of [12, true, ['not-string'], 'x'.repeat(256)]) await expect(f.call('POST', '/v2/wechat/profile', { nickname })).rejects.toMatchObject({ status: 500, message: 'Failed to save user profile' });
  });
  it('profile length counts Unicode characters rather than JavaScript UTF-16 units', async () => {
    const f = fixture(); const nickname = '😀'.repeat(200);
    expect(await f.call('POST', '/v2/wechat/profile', { nickname })).toMatchObject({ success: true, data: { user: { nickname } } });
  });
  it('login validates the provider user string lengths before inserting the account', async () => {
    const f = fixture();
    f.session.mockResolvedValueOnce({ openid: 'o', unionid: 'u'.repeat(256) });
    await expect(f.call('POST', '/v2/site/login', { code: 'test' })).rejects.toMatchObject({ status: 401, message: '微信账号登录失败' });
    expect(f.db.insert).not.toHaveBeenCalled();
  });
  it('payment JSON overrides are applied after authentication and before action validation', async () => {
    const f = fixture();
    for (const [method, action] of [['POST', 'wxpay-order'], ['GET', 'wxpay-query-order-by-out-trade-no'], ['GET', 'wxpay-query-order-by-transaction-id'], ['POST', 'wxpay-refund'], ['GET', 'wxpay-query-refund']]) {
      f.res.setHeader.mockClear();
      await f.call(method, `/v1/wechat-pay/${action}`);
      expect(f.res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json; charset=UTF-8');
      f.res.setHeader.mockClear(); f.auth.bearer.mockRejectedValueOnce(new ApiError(401, 'Unauthorized'));
      await expect(f.call(method, `/v2/wechat-pay/${action}`)).rejects.toMatchObject({ status: 401 });
      expect(f.res.setHeader).not.toHaveBeenCalled();
    }
  });
});
