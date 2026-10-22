import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
export const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');
export function equal(left: unknown, right: unknown): boolean { return typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
export interface BrowserState {
  csrf: string;
  owner?: string;
  currentTicket?: string;
  identity?: { source: 'password' | 'wechat'; username: string; expiresAt: number; wechatUserId?: number };
  rotate?: boolean;
}
export class BrowserSessions {
  constructor(private readonly db: Database) {}
  async run<T>(ctx: Context, operation: (state: BrowserState) => Promise<T>): Promise<T> {
    const cookieName = process.env.ADMIN_SESSION_COOKIE || 'game_session';
    const cookie = ctx.req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    let sid = typeof cookie === 'string' && /^[a-f0-9]{64}$/.test(cookie) ? cookie : randomBytes(32).toString('hex');
    let result: T | undefined, failure: unknown;
    ctx.res.setHeader('Cache-Control', 'no-store');
    await this.db.transaction(async db => {
      const now = Math.floor(Date.now() / 1000);
      const stored = await db.one('SELECT * FROM node_browser_session WHERE id_hash=? FOR UPDATE', [sha256(sid)]);
      let isNew = !stored || Number(stored.expires_at) <= now;
      if (isNew && stored) await db.delete('node_browser_session', sha256(sid));
      if (isNew) sid = randomBytes(32).toString('hex');
      const state: BrowserState = isNew ? { csrf: randomBytes(32).toString('hex') } : typeof stored!.data === 'string' ? JSON.parse(stored!.data) : stored!.data;
      if (!isNew && (!state || typeof state.csrf !== 'string')) throw new ApiError(503, '会话暂时不可用，请重新登录');
      try {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method) && !equal(ctx.req.headers['x-csrf-token'] ?? ctx.body['_csrf-api'], state.csrf)) throw new ApiError(400, 'Unable to verify your data submission.');
        result = await operation(state);
      } catch (error) { failure = error; }
      if (state.rotate) {
        if (!isNew) await db.delete('node_browser_session', sha256(sid));
        sid = randomBytes(32).toString('hex');
        state.csrf = randomBytes(32).toString('hex');
        delete state.rotate;
        // Route responses expose the token belonging to the rotated session.
        if (result && typeof result === 'object' && 'csrfToken' in result) (result as Row).csrfToken = state.csrf;
        isNew = true;
      }
      const data = { data: state, expires_at: now + 28800 };
      if (isNew) await db.insert('node_browser_session', { id_hash: sha256(sid), ...data });
      else await db.update('node_browser_session', sha256(sid), data);
      if (isNew) ctx.res.cookie(cookieName, sid, { httpOnly: true, secure: ctx.req.secure, sameSite: 'lax', path: '/', maxAge: 28800000 });
      await db.execute('DELETE FROM node_browser_session WHERE expires_at < ? LIMIT 100', [now - 86400]);
    });
    if (failure) throw failure;
    return result!;
  }
  async user(state: BrowserState): Promise<Row | null> {
    const identity = state.identity;
    if (!identity || identity.expiresAt <= Math.floor(Date.now() / 1000)) { delete state.identity; return null; }
    if (identity.source === 'wechat') {
      if (!Number.isInteger(identity.wechatUserId) || identity.username !== `wechat:${identity.wechatUserId}` || !await this.db.one('SELECT id FROM user WHERE id=?', [identity.wechatUserId])) { delete state.identity; return null; }
      return { username: identity.username, role: 'device_manager' };
    }
    if (identity.source !== 'password' || !equal(identity.username, process.env.ADMIN_USERNAME || 'dirui')) { delete state.identity; return null; }
    return { username: identity.username, role: 'admin' };
  }
  async scope(state: BrowserState): Promise<number | null> {
    const user = await this.user(state);
    if (!user) throw new ApiError(401, '请先登录设备管理后台');
    return user.role === 'admin' ? null : state.identity!.wechatUserId!;
  }
}
/** Persisted independently of login transactions, so rejected attempts cannot roll the counter back. */
export async function throttle(db: Database, ctx: Context, key: string, limit: number, window: number, count = true): Promise<void> {
  const now = Math.floor(Date.now() / 1000), id = sha256(key);
  const limited = await db.transaction(async tx => {
    await tx.execute('INSERT IGNORE INTO node_rate_limit (id,count,expires_at) VALUES (?,0,?)', [id, now + window]);
    const row = (await tx.one('SELECT * FROM node_rate_limit WHERE id=? FOR UPDATE', [id]))!;
    if (Number(row.expires_at) <= now) { row.count = 0; row.expires_at = now + window; }
    if (Number(row.count) >= limit) return Number(row.expires_at) - now;
    await tx.update('node_rate_limit', id, { count: Number(row.count) + Number(count), expires_at: row.expires_at });
    return 0;
  });
  if (limited) { ctx.res.setHeader('Retry-After', String(Math.max(1, limited))); throw new ApiError(429, key.startsWith('login:') ? '登录尝试过于频繁，请稍后重试' : '扫码操作过于频繁，请稍后重试'); }
}
