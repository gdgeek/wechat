import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminRedisOptions, buildRedisKey } from '../src/core/redis';
import { ApiRouter } from '../src/core/router';
import { AuthService } from '../src/core/auth';
import jwt from 'jsonwebtoken';
import type { Database } from '../src/core/database';

describe('Yii compatibility primitives', () => {
  it('uses a dedicated admin Redis connection without changing business Redis', () => {
    const env = { REDIS_HOST: 'business', REDIS_PORT: '6379', REDIS_DB: '4', REDIS_PASSWORD: 'business-pass',
      ADMIN_AUTH_REDIS_HOST: 'authentication', ADMIN_AUTH_REDIS_PORT: '6381', ADMIN_AUTH_REDIS_DB: '0', ADMIN_AUTH_REDIS_PASSWORD: 'admin-pass' };
    expect(adminRedisOptions(env)).toMatchObject({ host: 'authentication', port: 6381, database: 0, password: 'admin-pass', timeout: 1500 });
    expect(env.REDIS_DB).toBe('4');
    expect(adminRedisOptions({ REDIS_HOST: 'business', REDIS_PORT: '6380', REDIS_DB: '4' })).toMatchObject({ host: 'business', port: 6380, database: 4 });
  });
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

describe('Yii PEM file as an HS256 secret', () => {
  let directory: string;
  let pem: string;
  const db = { one: async () => ({ id: 1, role: 'user' }), query: async () => [] } as unknown as Database;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wechat-business-jwt-'));
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'sec1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    pem = keys.privateKey.replace(/\n/g, '\r\n');
    const path = join(directory, 'ecc-private-key.pem');
    writeFileSync(path, pem, { mode: 0o600 });
    vi.stubEnv('JWT_SECRET', undefined);
    vi.stubEnv('JWT_KEY', path);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
  it('verifies a Yii-equivalent HS256 token signed with the complete file bytes', async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'HS256' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ uid: 1, identityDomain: 'v2-user', iss: 'https://example.com', iat: now, nbf: now, exp: now + 10800 })).toString('base64url');
    const data = `${header}.${claims}`;
    const token = `${data}.${createHmac('sha256', pem).update(data).digest('base64url')}`;
    const auth = new AuthService(db);
    await expect(auth.verifyToken(token, 'v2-user')).resolves.toMatchObject({ id: 1 });
    await expect(auth.verifyToken(token, 'v1-player')).rejects.toMatchObject({ status: 401 });
  });
  it('issues access and refresh signatures matching raw HMAC without normalizing PEM bytes', () => {
    const pair = new AuthService(db).issue({ id: 1 }, 'v2-user', 'https://example.com');
    for (const token of [pair.accessToken, pair.refreshToken]) {
      const [header, claims, signature] = token.split('.');
      expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe('HS256');
      expect(signature).toBe(createHmac('sha256', pem).update(`${header}.${claims}`).digest('base64url'));
      expect(signature).not.toBe(createHmac('sha256', pem.replace(/\r\n/g, '\n')).update(`${header}.${claims}`).digest('base64url'));
    }
  });
  it('continues to reject asymmetric JWT algorithms', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ uid: 1, identityDomain: 'v2-user', iat: now, nbf: now, exp: now + 10800 }, pem, { algorithm: 'ES256' });
    await expect(new AuthService(db).verifyToken(token, 'v2-user')).rejects.toMatchObject({ status: 401 });
  });
});
