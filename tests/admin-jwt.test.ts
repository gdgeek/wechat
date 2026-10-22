import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { ApiRouter } from '../src/core/router';
import { registerAdmin } from '../src/admin';
import type { Context, Row, Services } from '../src/core/contracts';
import { AdminTokens } from '../src/admin/tokens';
import { AdminTokenStore } from '../src/admin/token-store';
import { AdminAuth } from '../src/admin/auth';
import { sha256 } from '../src/admin/sessions';
import { ScanTickets } from '../src/admin/tickets';

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const keyDir = mkdtempSync(join(tmpdir(), 'wechat-admin-jwt-'));
writeFileSync(join(keyDir, 'private.pem'), keys.privateKey);
writeFileSync(join(keyDir, 'public.pem'), keys.publicKey);
const environment = { ...process.env };
afterEach(() => { process.env = { ...environment }; });
afterAll(() => rmSync(keyDir, { recursive: true, force: true }));

/** Implements Redis atomic primitives for isolated route contract tests. */
export class AuthRedis {
  values = new Map<string, string>();
  commands: string[][] = [];
  unavailable = false;
  async command(args: string[]): Promise<any> {
    this.commands.push(args);
    if (this.unavailable) throw new Error('private Redis failure');
    const [command, ...rest] = args;
    if (command === 'GET') return this.values.get(rest[0]) ?? null;
    if (command === 'DEL') return Number(this.values.delete(rest[0]));
    if (command === 'SET') {
      if (rest.includes('NX') && this.values.has(rest[0])) return null;
      this.values.set(rest[0], rest[1]); return 'OK';
    }
    if (command === 'EVAL') {
      const [script, _count, key, ...argv] = rest;
      const raw = this.values.get(key);
      if (script.includes('password') || script.includes("redis.call('INCR'")) {
        const count = Number(raw ?? 0);
        if (count >= Number(argv[0])) return [0, count, 60];
        this.values.set(key, String(count + 1)); return [1, count + 1, 60];
      }
      if (script.includes('row.refreshHash=ARGV[2]')) {
        if (!raw) return null;
        const record = JSON.parse(raw);
        if (record.expiresAt <= Number(argv[2]) || record.refreshHash !== argv[0]) return null;
        record.refreshHash = argv[1]; const result = JSON.stringify(record); this.values.set(key, result); return result;
      }
      if (script.includes('row.refreshHash~=ARGV[1]')) {
        if (!raw || JSON.parse(raw).refreshHash !== argv[0]) return 0;
        return Number(this.values.delete(key));
      }
      if (script.includes('PEXPIRE')) return Number(raw === argv[0]);
      if (script.includes("redis.call('GET',KEYS[1])==ARGV[1]")) return raw === argv[0] ? Number(this.values.delete(key)) : 0;
    }
    throw new Error(`Unexpected isolated Redis command ${command}`);
  }
}

function fixture() {
  process.env.ADMIN_USERNAME = 'test-admin';
  process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('password', 4);
  process.env.ADMIN_SCAN_LOGIN_ORIGIN = 'https://admin.example';
  process.env.ADMIN_AUTH_ISSUER = 'https://admin.example';
  process.env.ADMIN_JWT_KEY = join(keyDir, 'private.pem');
  process.env.ADMIN_JWT_PUB_KEY = join(keyDir, 'public.pem');
  const redis = new AuthRedis();
  const db = { one: async (sql: string) => sql.includes('node_rate_limit') ? { count: 0, expires_at: Math.floor(Date.now() / 1000) + 60 } : null, execute: async () => ({ affectedRows: 1 }), insert: async (_table: string, row: Row) => row, update: async (_table: string, _id: unknown, row: Row) => row, transaction: async (operation: any) => operation(db) };
  const services = { db, redis, auth: { bearer: async () => ({ id: 1 }) }, catalog: { getGames: async () => [] } } as unknown as Services;
  const router = new ApiRouter(); registerAdmin(router, services);
  const ctx = (method: string, body: Row = {}, headers: Row = {}) => ({ req: { method, headers, ip: '127.0.0.1' }, res: { setHeader() {}, cookie() {} }, body, query: {}, params: {} }) as unknown as Context;
  return { router, services, redis, ctx };
}

async function login(f: ReturnType<typeof fixture>) {
  return await f.router.match('POST', '/admin-api/login')!.route.handler(f.ctx('POST', { username: 'test-admin', password: 'password' })) as any;
}

async function session(f: ReturnType<typeof fixture>, accessToken: string) {
  return f.router.match('GET', '/admin-api/session')!.route.handler(f.ctx('GET', {}, { authorization: `Bearer ${accessToken}` }));
}

describe('current game administrator transport', () => {
  it('accepts password login without a browser session or CSRF token', async () => {
    const { router, ctx } = fixture();
    // Missing signing configuration is reached only after credentials pass.
    process.env.ADMIN_JWT_KEY = '/nonexistent-admin-private.pem';
    await expect(router.match('POST', '/admin-api/login')!.route.handler(ctx('POST', { username: 'test-admin', password: 'password' }))).rejects.toMatchObject({ status: 503 });
  });
  it('registers the current refresh endpoint and validates its payload', async () => {
    const { router, ctx } = fixture();
    const route = router.match('POST', '/admin-api/refresh');
    expect(route).not.toBeNull();
    await expect(route!.route.handler(ctx('POST'))).rejects.toMatchObject({ status: 422 });
  });
  it('returns JWT session metadata without creating a cookie or CSRF credential', async () => {
    const { router, ctx, redis } = fixture();
    const result = await router.match('GET', '/admin-api/session')!.route.handler(ctx('GET'));
    expect(result).toEqual({ user: null, scanLoginEnabled: true, authMode: 'jwt' });
    expect(redis.commands).toEqual([]);
  });
  it('issues ES256 game-admin claims and a hashed one-use refresh family using the Yii key format', async () => {
    const f = fixture(), result = await login(f);
    expect(result).toMatchObject({ authMode: 'jwt', user: { username: 'test-admin', role: 'admin' } });
    const claims = jwt.verify(result.token.accessToken, keys.publicKey, { algorithms: ['ES256'] }) as jwt.JwtPayload;
    expect(claims).toMatchObject({ iss: 'https://admin.example', aud: 'game-admin', identityDomain: 'game-admin', tokenUse: 'access', sub: claims.sid });
    expect(claims.exp! - claims.iat!).toBe(10800);
    expect(result.token.refreshToken).toMatch(new RegExp(`^${claims.sid}\\.[a-f0-9]{64}$`));
    const [key, value] = [...f.redis.values.entries()].find(([key]) => key.includes(':sid:'))!;
    expect(key).toMatch(/^game:admin:auth:issuer:[a-f0-9]{64}:sid:[a-f0-9]{32}$/);
    const record = JSON.parse(value);
    expect(record).toMatchObject({ issuer: 'https://admin.example', identity: { source: 'password', username: 'test-admin' } });
    expect(record.identity.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(value).not.toContain(result.token.refreshToken);
    expect(await session(f, result.token.accessToken)).toMatchObject({ authMode: 'jwt', user: { role: 'admin' } });
  });
  it('rotates refresh credentials only once, preserves the deadline and revokes with an older access token', async () => {
    const f = fixture(), initial = await login(f);
    const refresh = (value: string) => f.router.match('POST', '/admin-api/refresh')!.route.handler(f.ctx('POST', { refreshToken: value })) as Promise<any>;
    const next = await refresh(initial.token.refreshToken);
    expect(next.token.refreshToken).not.toBe(initial.token.refreshToken);
    expect(next.token.refreshExpires).toBe(initial.token.refreshExpires);
    await expect(refresh(initial.token.refreshToken)).rejects.toMatchObject({ status: 401 });
    const output = await f.router.match('POST', '/admin-api/logout')!.route.handler(f.ctx('POST', { refreshToken: initial.token.refreshToken }, { authorization: `Bearer ${initial.token.accessToken}` }));
    expect(output).toEqual({ user: null, authMode: 'jwt' });
    await expect(session(f, next.token.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(refresh(next.token.refreshToken)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects valid signatures with the wrong audience/domain, missing times or a foreign issuer', async () => {
    const f = fixture(), initial = await login(f);
    const base = jwt.decode(initial.token.accessToken) as jwt.JwtPayload;
    for (const patch of [{ identityDomain: 'v2-user' }, { aud: ['v2-user'] }, { aud: ['game-admin', 'foreign'] }, { tokenUse: 'refresh' }, { iss: 'https://foreign.example' }, { iat: undefined }, { nbf: undefined }, { exp: undefined }, { exp: base.iat! + 10801 }]) {
      const claims = { ...base, ...patch };
      for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
      const token = jwt.sign(claims, keys.privateKey, { algorithm: 'ES256', noTimestamp: patch.iat === undefined && Object.hasOwn(patch, 'iat') });
      await expect(session(f, token)).rejects.toMatchObject({ status: 401 });
    }
  });
  it('invalidates password identities immediately after the configured password hash changes', async () => {
    const f = fixture(), initial = await login(f);
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('replacement', 4);
    await expect(session(f, initial.token.accessToken)).rejects.toMatchObject({ status: 401 });
  });
  it('fails closed without leaking Redis errors and reserves attempts before password verification', async () => {
    const f = fixture();
    f.redis.unavailable = true;
    await expect(login(f)).rejects.toMatchObject({ status: 503, message: '管理认证服务暂时不可用，请稍后重试' });
    f.redis.unavailable = false;
    for (let i = 0; i < 5; i++) await expect(f.router.match('POST', '/admin-api/login')!.route.handler(f.ctx('POST', { username: 'bad', password: 'wrong' }))).rejects.toMatchObject({ status: 401 });
    await expect(login(f)).rejects.toMatchObject({ status: 429 });
    const key = [...f.redis.values.keys()].find(key => key.includes(':password-attempts:'))!;
    expect(key).toMatch(/^game:admin:auth:issuer:[a-f0-9]{64}:password-attempts:[a-f0-9]{64}$/);
  });
  it('requires the scan owner header independently of browser cookies', async () => {
    const f = fixture(), route = f.router.match('POST', '/admin-api/scan-login/tickets')!.route;
    await expect(route.handler(f.ctx('POST'))).rejects.toMatchObject({ status: 400, message: '扫码浏览器凭据无效' });
    const result = await route.handler(f.ctx('POST', {}, { 'x-admin-scan-owner': 'a'.repeat(64) }));
    expect(result).toMatchObject({ ticketId: expect.stringMatching(/^[a-f0-9]{32}$/), qrText: expect.stringContaining('bujiaban-admin-login://v1/') });
    expect([...f.redis.values.keys()].some(key => key.includes('owner-lock:'))).toBe(false);
  });
  it('keeps disabled or mismatched ticket audiences forbidden for status and cancel', async () => {
    const f = fixture(), owner = 'a'.repeat(64), id = 'b'.repeat(32);
    const row = { id, owner_hash: sha256(owner), audience: 'https://admin.example', status: 'pending', expires_at: Math.floor(Date.now() / 1000) + 300 };
    f.services.db.one = async () => row;
    delete process.env.ADMIN_SCAN_LOGIN_ORIGIN;
    const auth = new AdminAuth(f.services.db, new AdminTokens(new AdminTokenStore(f.redis)));
    const tickets = new ScanTickets(f.services, auth), ctx = f.ctx('GET', {}, { 'x-admin-scan-owner': owner }); ctx.params.id = id;
    await expect(tickets.status(ctx)).rejects.toMatchObject({ status: 403 });
    await expect(tickets.cancel(ctx)).rejects.toMatchObject({ status: 403 });
  });
});

describe('administrator state across runtime instances', () => {
  const identity = { source: 'password' as const, username: 'test-admin', credentialFingerprint: 'a'.repeat(64) };
  function tokens(redis: AuthRedis, now: () => number, issuer = 'https://admin.example') {
    return new AdminTokens(new AdminTokenStore(redis), { now, issuer, privateKey: keys.privateKey, publicKey: keys.publicKey });
  }
  it('accepts a Yii-shaped token and Redis record independently of the issuing runtime', async () => {
    const redis = new AuthRedis(), now = 2000000000, sid = 'a'.repeat(32);
    // Lcobucci UnifyAudience serializes one audience as a JSON string; its parser
    // normalizes that back to the array checked by the Yii authentication code.
    const token = jwt.sign({ iss: 'https://admin.example', aud: 'game-admin', sub: sid, jti: 'b'.repeat(32), iat: now, nbf: now, exp: now + 10800, identityDomain: 'game-admin', tokenUse: 'access', sid }, keys.privateKey, { algorithm: 'ES256' });
    const refresh = `${sid}.${'c'.repeat(64)}`;
    redis.values.set(`game:admin:auth:issuer:${sha256('https://admin.example')}:sid:${sid}`, JSON.stringify({ identity, issuer: 'https://admin.example', expiresAt: now + 28800, refreshHash: sha256(refresh) }));
    const reader = tokens(redis, () => now);
    expect(await reader.identity(`Bearer ${token}`)).toEqual(identity);
    expect((await reader.refresh(refresh)).identity).toEqual(identity);
  });
  it('does not extend the absolute eight-hour deadline while issuing shorter access credentials near expiry', async () => {
    const redis = new AuthRedis(); let now = 2000000000;
    const first = tokens(redis, () => now), other = tokens(redis, () => now);
    const initial = await first.issue(identity), deadline = now + 28800;
    now = deadline - 10;
    const next = await other.refresh(initial.refreshToken);
    const claims = jwt.decode(next.token.accessToken) as jwt.JwtPayload;
    expect(claims.exp).toBe(deadline);
    expect(claims.exp! - claims.iat!).toBe(10);
    expect(next.token.refreshExpires).toBe(initial.refreshExpires);
    now = deadline;
    await expect(first.identity(`Bearer ${next.token.accessToken}`)).rejects.toMatchObject({ status: 401 });
    await expect(first.refresh(next.token.refreshToken)).rejects.toMatchObject({ status: 401 });
  });
  it('allows only one concurrent refresh and shares issuer-isolated revocation between instances', async () => {
    const redis = new AuthRedis(), now = () => 2000000000;
    const first = tokens(redis, now), other = tokens(redis, now), foreign = tokens(redis, now, 'https://foreign.example');
    const initial = await first.issue(identity);
    const outcomes = await Promise.allSettled([first.refresh(initial.refreshToken), other.refresh(initial.refreshToken)]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1);
    await expect(foreign.identity(`Bearer ${initial.accessToken}`)).rejects.toMatchObject({ status: 401 });
    await expect(foreign.refresh(initial.refreshToken)).rejects.toMatchObject({ status: 401 });
    await other.revoke(`Bearer ${initial.accessToken}`);
    await expect(first.identity(`Bearer ${initial.accessToken}`)).rejects.toMatchObject({ status: 401 });
  });
  it('keeps WeChat administrator scope tied to a live user and ignores a legacy cookie', async () => {
    const redis = new AuthRedis(), tokenService = tokens(redis, () => Math.floor(Date.now() / 1000));
    let live = true;
    const auth = new AdminAuth({ one: async () => live ? { id: 7 } : null } as any, tokenService);
    const issued = await tokenService.issue({ source: 'wechat', username: 'wechat:7', wechatUserId: 7 });
    const context = { req: { headers: { authorization: `Bearer ${issued.accessToken}`, cookie: 'game_session=old-browser-identity' } } } as unknown as Context;
    expect(await auth.scope(context)).toBe(7);
    expect(await auth.user(context)).toEqual({ username: 'wechat:7', role: 'device_manager' });
    live = false;
    await expect(auth.scope(context)).rejects.toMatchObject({ status: 401 });
    delete context.req.headers.authorization;
    expect(await auth.user(context)).toBeNull();
  });
  it('checks owner leases in the matching async request and refuses work after the lease is lost', async () => {
    const redis = new AuthRedis(), store = new AdminTokenStore(redis), owner = 'a'.repeat(64);
    await expect(store.assertOwnerLock(owner)).rejects.toMatchObject({ status: 503 });
    await store.withOwnerLock(owner, async () => {
      await store.assertOwnerLock(owner);
      redis.values.set(`game:admin:auth:owner-lock:${owner}`, 'replacement-owner');
      await expect(store.assertOwnerLock(owner)).rejects.toMatchObject({ status: 503 });
    });
    expect(redis.values.get(`game:admin:auth:owner-lock:${owner}`)).toBe('replacement-owner');
    await expect(new AdminTokenStore(redis, { ownerWaitMilliseconds: 0 }).withOwnerLock(owner, async () => 1)).rejects.toMatchObject({ status: 503 });
  });
  it('serializes simultaneous same-owner callbacks across independent store instances', async () => {
    const redis = new AuthRedis(), first = new AdminTokenStore(redis), other = new AdminTokenStore(redis), owner = 'b'.repeat(64);
    const sequence: string[] = [];
    await Promise.all([
      first.withOwnerLock(owner, async () => { sequence.push('first'); await new Promise(resolve => setTimeout(resolve, 20)); await first.assertOwnerLock(owner); sequence.push('first-done'); }),
      other.withOwnerLock(owner, async () => { sequence.push('other'); await other.assertOwnerLock(owner); sequence.push('other-done'); }),
    ]);
    expect(sequence).toEqual(['first', 'first-done', 'other', 'other-done']);
    expect(redis.values.has(`game:admin:auth:owner-lock:${owner}`)).toBe(false);
  });
});
