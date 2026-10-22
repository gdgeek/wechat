import { describe, expect, it } from 'vitest';
import { buildRedisKey } from '../src/core/redis';
import { ApiRouter } from '../src/core/router';
import { AuthService } from '../src/core/auth';
import jwt from 'jsonwebtoken';
import type { Database } from '../src/core/database';

describe('Yii compatibility primitives', () => {
  it('uses Yii Redis key normalization including hashed long tokens', () => {
    expect(buildRedisKey('abc123')).toBe('abc123');
    expect(buildRedisKey('A' + '0'.repeat(32))).toBe('7591abb0d4fe2a429698e9b24612a95c');
  });
  it('matches static routes before item placeholders and distinguishes HTTP verbs', () => {
    const router = new ApiRouter();
    router.add('GET', '/v2/devices/manage', () => 'owned');
    router.add('PUT', '/v2/devices/:id', ctx => ctx.params.id);
    expect(router.match('GET', '/v2/devices/manage')?.route.path).toBe('/v2/devices/manage');
    expect(router.match('PUT', '/v2/devices/123')?.params.id).toBe('123');
    expect(router.match('DELETE', '/v2/devices/123')).toBeNull();
    expect(router.match('PUT', '/v2/devices/not-a-number')).toBeNull();
  });
});

describe('Bearer domain boundary', () => {
  const key = 'unit-test-signing-key-with-at-least-32-bytes';
  const db = { one: async () => ({ id: 1, role: 'user' }), query: async () => [], update: async (_t: string, _i: unknown, data: unknown) => data } as unknown as Database;
  const auth = new AuthService(db, { jwtKey: key });
  it('accepts matching signed tokens and rejects cross-domain tokens', async () => {
    const pair = auth.issue({ id: 1 }, 'v2-user', 'https://example.com');
    await expect(auth.verifyToken(pair.accessToken, 'v2-user')).resolves.toMatchObject({ id: 1 });
    await expect(auth.verifyToken(pair.accessToken, 'v1-player')).rejects.toMatchObject({ status: 401 });
  });
  it('requires every temporal claim and a positive integer uid', async () => {
    for (const claims of [
      { uid: 1, identityDomain: 'v2-user' },
      { uid: '1', identityDomain: 'v2-user', exp: 9999999999, nbf: 1 },
      { uid: 1, identityDomain: 'v2-user', exp: 1, nbf: 1 },
    ]) await expect(auth.verifyToken(jwt.sign(claims, key), 'v2-user')).rejects.toMatchObject({ status: 401 });
  });
});
