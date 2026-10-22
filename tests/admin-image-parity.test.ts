import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { registerAdmin } from '../src/admin';
import { AdminAuth } from '../src/admin/auth';
import { normalizeDevice } from '../src/admin/devices';
import { errorPayload } from '../src/core/errors';
import { ApiRouter } from '../src/core/router';
import type { Context, Row, Services } from '../src/core/contracts';
import { Integrations } from '../src/integrations/integrations';

const host = 'preview-fixture-1250000000.cos.ap-nanjing.myqcloud.com';
const base = `https://${host}`;
const now = 1_800_000_000;
afterEach(() => vi.restoreAllMocks());
function fixture(pictures: unknown = [`${base}/picture/t1.png`], thumbs: unknown = []) {
  const user = vi.spyOn(AdminAuth.prototype, 'user').mockResolvedValue({ username: 'admin', role: 'admin' });
  const scope = vi.spyOn(AdminAuth.prototype, 'scope').mockResolvedValue(null);
  const setup: Row = { id: 1, device_id: 1, pictures, thumbs };
  const devices = [{ id: 1 }, { id: 2 }];
  const db = { one: vi.fn(async (sql: string, values: any[]) => {
    if (sql.includes('FROM device')) return devices.find(d => d.id === values[0] && (values.length < 2 || values[1] === 42 && d.id === 1)) ?? null;
    if (sql.includes('FROM setup')) return values[0] === 1 ? setup : null;
    throw Error('unexpected query');
  }), insert: vi.fn(), update: vi.fn(), execute: vi.fn() };
  const fetcher = vi.fn();
  const integrations = new Integrations({ bucket: 'preview-fixture-1250000000', region: 'ap-nanjing', secretId: 'test-only-id', secretKey: 'test-only-key', now: () => now, fetch: fetcher });
  const bearer = vi.fn(async () => ({ id: 42 }));
  const services = { db, integrations, auth: { bearer } } as unknown as Services;
  const router = new ApiRouter(); registerAdmin(router, services);
  const call = async (id = 1, query: Row = {}) => {
    const route = router.match('GET', `/admin-api/devices/${id}/image-previews`);
    expect(route, 'Yii image-previews GET route must exist').not.toBeNull();
    const res = { setHeader: vi.fn() };
    const result = await route!.route.handler({ req: { headers: {} }, res, query, body: {}, params: route!.params } as unknown as Context);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    return result as { previews: Row[] };
  };
  return { router, call, user, scope, setup, db, integrations, fetcher, bearer };
}

function assertSignature(entry: Row) {
  const url = new URL(entry.url);
  expect(url.hostname).toBe(host);
  expect([...url.searchParams.keys()]).toEqual(['sign']);
  const sign = new URLSearchParams(url.searchParams.get('sign')!);
  expect(sign.get('q-sign-algorithm')).toBe('sha1');
  expect(sign.get('q-header-list')).toBe('host');
  expect(sign.get('q-url-param-list')).toBe('');
  expect(sign.get('q-sign-time')).toBe(`${now};${now + 300}`);
  expect(sign.get('q-key-time')).toBe(sign.get('q-sign-time'));
  const http = `get\n${decodeURIComponent(url.pathname)}\n\nhost=${host}\n`;
  const sha = createHash('sha1').update(http).digest('hex');
  const key = createHmac('sha1', 'test-only-key').update(sign.get('q-sign-time')!).digest('hex');
  const expected = createHmac('sha1', key).update(`sha1\n${sign.get('q-sign-time')}\n${sha}\n`).digest('hex');
  expect(sign.get('q-signature')).toBe(expected);
  expect(entry.expiresAt).toBe(now + 300);
}

describe('latest Yii administrator device and preview contracts', () => {
  it('exposes generic Yii HttpException for unavailable image signatures', async () => {
    const f = fixture(); f.integrations.config.secretKey = '';
    try { await f.call(); throw Error('expected failure'); }
    catch (error) { expect(errorPayload(error).body).toMatchObject({ status: 503, type: 'yii\\web\\HttpException' }); }
  });
  it('checks the mini program bearer before reading approval body parameters', async () => {
    const f = fixture();
    f.bearer.mockRejectedValueOnce(new Error('invalid-bearer'));
    const route = f.router.match('POST', `/v2/web-login/tickets/${'a'.repeat(32)}/approve`)!;
    await expect(route.route.handler({ req: { headers: {} }, res: { setHeader: vi.fn() }, body: {}, params: route.params } as unknown as Context)).rejects.toThrow('invalid-bearer');
  });
  it('returns the stored integer protocol version in every normalized device', () => {
    expect(normalizeDevice({ id: 1, version: '27' }, null)).toMatchObject({ version: 27 });
    expect(normalizeDevice({ id: 1 }, null)).toMatchObject({ version: 0 });
  });
  it('signs saved pictures and thumbs for exactly five minutes without writes or provider traffic', async () => {
    const f = fixture([`${base}/picture/t1.png`], [`${base}/picture/t1.webp`]);
    const result = await f.call(1, { key: 'other-owner.png', method: 'PUT', expires: 86400 });
    expect(Object.keys(result)).toEqual(['previews']);
    expect(result.previews).toHaveLength(2);
    for (const entry of result.previews) assertSignature(entry);
    for (const mutation of [f.db.insert, f.db.update, f.db.execute, f.fetcher]) expect(mutation).not.toHaveBeenCalled();
  });
  it('matches COS SDK empty-segment normalization while keeping each saved source', async () => {
    const sources = [`${base}/a//b.png`, `${base}///folder//`];
    const { previews } = await fixture(sources).call();
    expect(previews.map(entry => entry.source)).toEqual(sources);
    expect(previews.map(entry => new URL(entry.url).pathname)).toEqual(['/a/b.png', '/folder/']);
    await expect(fixture([`${base}//`]).call()).rejects.toMatchObject({ status: 503, message: '图片预览暂时不可用，请稍后重试' });
  });
  it('keeps one absolute expiration even when signing crosses a second boundary', async () => {
    const f = fixture([`${base}/a.png`, `${base}/b.png`]);
    vi.spyOn(f.integrations, 'now').mockReturnValueOnce(now).mockReturnValue(now + 1);
    const { previews } = await f.call();
    for (const entry of previews) {
      const signature = new URLSearchParams(new URL(entry.url).searchParams.get('sign')!);
      expect(Number(signature.get('q-sign-time')!.split(';')[1])).toBe(entry.expiresAt);
      expect(entry.expiresAt).toBe(now + 300);
    }
  });
  it('requires admin authentication and checks current manager device ownership', async () => {
    const f = fixture();
    f.user.mockResolvedValueOnce(null);
    await expect(f.call()).rejects.toMatchObject({ status: 401, message: '请先登录管理后台' });
    expect(f.db.one).not.toHaveBeenCalled();
    f.scope.mockResolvedValue(42);
    expect((await f.call()).previews).toHaveLength(1);
    for (const id of [2, 999]) await expect(f.call(id)).rejects.toMatchObject({ status: 404, message: '设备不存在' });
  });
  it('returns empty previews for missing setup and external images without requiring credentials', async () => {
    const f = fixture(['https://example.com/image.png']);
    f.integrations.config.bucket = undefined; f.integrations.config.secretKey = undefined;
    expect(await f.call()).toEqual({ previews: [] });
    expect(await f.call(2)).toEqual({ previews: [] });
  });
  it('does not sign invalid URLs, foreign buckets, path traversal or supplied ports', async () => {
    const f = fixture([
      `${base}.evil.example/a`, 'https://other-1250000000.cos.ap-nanjing.myqcloud.com/a',
      `https://user@${host}/a`, `https://${host}:443/a`, `http://${host}/a`, `${base}/`,
      `${base}/a/../private`, `${base}/a/%2e%2e/private`, `${base}/bad%ZZ`, `${base}/bad%00`, `${base}/bad%5c`, `${base}/bad%7f`, `${base}/bad\nname`,
    ]);
    f.integrations.config.secretKey = undefined;
    expect(await f.call()).toEqual({ previews: [] });
  });
  it('deduplicates normalized sources and discards saved query and fragment overrides', async () => {
    const source = `${base}/picture/a%20b%252Fc.png?sign=expired&response-content-type=text/html#fragment`;
    const f = fixture([` ${source} `, source, null, ''], [source, `${base}/picture/%E4%B8%AD%E6%96%87.png`]);
    const { previews } = await f.call();
    expect(previews.map(entry => entry.source)).toEqual([source, `${base}/picture/%E4%B8%AD%E6%96%87.png`]);
    expect(new URL(previews[0].url).pathname).toBe('/picture/a%20b%252Fc.png');
    for (const entry of previews) assertSignature(entry);
  });
  it('sanitizes required signing configuration failures and preserves database error boundaries', async () => {
    const f = fixture();
    f.integrations.config.secretKey = '';
    await expect(f.call()).rejects.toMatchObject({ status: 503, message: '图片预览暂时不可用，请稍后重试' });
    f.db.one.mockRejectedValueOnce(new Error('private SQL credentials'));
    await expect(f.call()).rejects.toMatchObject({ status: 503, message: '设备数据暂时不可用，请稍后重试' });
  });
  it('registers preview only for GET', () => {
    const f = fixture();
    expect(f.router.match('GET', '/admin-api/devices/1/image-previews')).not.toBeNull();
    for (const method of ['POST', 'PUT', 'DELETE']) expect(f.router.match(method, '/admin-api/devices/1/image-previews')).toBeNull();
  });
});
