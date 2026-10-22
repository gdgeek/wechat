import { describe, expect, it } from 'vitest';
import { ApiRouter } from '../src/core/router';
import { AuthService } from '../src/core/auth';
import type { Context } from '../src/core/contracts';
import { createHash } from 'node:crypto';
import { recordRequest, readRequest } from '../src/core/diagnostics';

describe('Yii explicit URL rules and authentication failures', () => {
  it('uses strict numeric admin ids while preserving comma ids only for generated REST rules', () => {
    const router = new ApiRouter();
    router.add('DELETE', '/admin-api/devices/:id', () => null);
    router.add('GET', '/v2/devices/:id', () => null);
    expect(router.match('DELETE', '/admin-api/devices/1,2')).toBeNull();
    expect(router.match('DELETE', '/admin-api/devices/12')?.params.id).toBe('12');
    expect(router.match('GET', '/v2/devices/1,2')?.params.id).toBe('1,2');
  });
  it('lets unrestricted assign placeholders reach authentication like Yii extraPatterns', () => {
    const router = new ApiRouter();
    router.add('DELETE', '/v2/devices/:device_id/assign/:user_id', () => null);
    expect(router.match('DELETE', '/v2/devices/device-name/assign/user-name')?.params).toEqual({ device_id: 'device-name', user_id: 'user-name' });
  });
  it('decodes the complete path once before strict matching without adding trailing slash routes', () => {
    const router = new ApiRouter();
    router.add('GET', '/health', () => null);
    router.add('GET', '/v2/devices/:id', () => null);
    router.add('DELETE', '/v2/devices/:device_id/assign/:user_id', () => null);
    expect(router.match('GET', '/health/')).toBeNull();
    expect(router.match('GET', '/%68ealth')?.route.path).toBe('/health');
    expect(router.match('GET', '/v2/devices/%31')?.params.id).toBe('1');
    expect(router.match('DELETE', '/v2/devices/a%2Fb/assign/z')).toBeNull();
    expect(router.match('DELETE', '/v2/devices/a%252Fb/assign/z')?.params.device_id).toBe('a%2Fb');
    expect(router.match('DELETE', '/v2/devices/a+b/assign/z')?.params.device_id).toBe('a b');
    expect(() => router.match('DELETE', '/v2/devices/a%xx/assign/z')).not.toThrow();
  });
  const auth = new AuthService({ one: async () => null } as any, { jwtKey: 'isolated-auth-test-secret-at-least-32-bytes' });
  function context(path: string, authorization?: string) {
    const headers: Record<string, string> = {};
    const ctx = { req: { path, headers: { authorization } }, res: { setHeader: (key: string, value: string) => { headers[key] = value; } } } as unknown as Context;
    return { ctx, headers };
  }
  it('matches direct JwtHttpBearerAuth failures on device/setup/scan routes', async () => {
    for (const path of ['/v2/devices', '/%76%32/devices', '/v2/setups/1', '/v2/web-login/tickets/' + 'a'.repeat(32) + '/approve']) {
      for (const token of [undefined, 'Bearer invalid']) {
        const { ctx, headers } = context(path, token);
        await expect(auth.bearer(ctx, 'v2-user')).rejects.toMatchObject({ status: 401, message: 'Your request was made with invalid or expired JSON Web Token.' });
        expect(headers['WWW-Authenticate']).toBe('Bearer realm="api"');
      }
    }
  });
  it('preserves CompositeAuth failures and sends the challenge for invalid tokens', async () => {
    const { ctx, headers } = context('/v2/files', 'Bearer invalid');
    await expect(auth.bearer(ctx, 'v2-user')).rejects.toMatchObject({ status: 401, message: 'Your request was made with invalid credentials.' });
    expect(headers['WWW-Authenticate']).toBe('Bearer realm="api"');
  });
  it('uses the legacy refresh-token error message in each identity domain', async () => {
    for (const domain of ['v1-player', 'v2-user'] as const) await expect(auth.refresh('invalid', domain, 'https://isolated.example')).rejects.toMatchObject({ status: 401, message: 'Invalid or expired refreshToken' });
  });
  it('decodes fingerprint inputs as PHP urldecode and accepts present zero strings', () => {
    for (const [openId, timestamp, decoded] of [['a%2Bb', '1', 'a+b'], ['0', '0', '0']]) {
      const fingerprint = createHash('md5').update(`geek.v0xe1.pa2ty.c0m${timestamp}${decoded}`).digest('hex');
      expect(() => auth.playerFingerprint({ req: { method: 'POST' }, body: { openId, timestamp, fingerprint } } as any)).not.toThrow();
    }
  });
  it('serializes empty diagnostic parameter arrays like Yii while redacting credentials', async () => {
    let saved: unknown;
    const services = { redis: { save: async (_model: string, value: unknown) => { saved = value; }, find: async () => saved } } as any;
    await recordRequest(services, { req: { method: 'GET', headers: { authorization: 'Bearer test-token' } }, body: {}, query: {} } as any, 'test');
    expect(await readRequest(services)).toEqual({ action: 'test', isGet: true, post: [], get: [], headers: { authorization: ['[redacted]'] } });
  });
});
