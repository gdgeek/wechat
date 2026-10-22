import bcrypt from 'bcryptjs';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { equal, sha256 } from './sessions';
import { type AdminIdentity } from './token-store';
import { AdminTokens } from './tokens';

const defaultHash = '$2y$12$3RAuTkI52n8qXYippmstTOyJbMslkfdtsRYghaxUSKlKP7g1u8c2.';
export class AdminAuth {
  constructor(private readonly db: Database, readonly tokens: AdminTokens) {}
  private username(): string { return process.env.ADMIN_USERNAME || 'dirui'; }
  private passwordHash(): string { return process.env.ADMIN_PASSWORD_HASH || defaultHash; }
  private publicUser(identity: AdminIdentity): Row { return { username: identity.username, role: identity.source === 'password' ? 'admin' : 'device_manager' }; }
  async requireWechatUser(id: number): Promise<void> {
    if (!await this.isWechatUser(id)) throw new ApiError(403, '微信账号已失效，请重新登录');
  }
  private async isWechatUser(id: number): Promise<boolean> {
    if (!Number.isInteger(id) || id <= 0) return false;
    try { return !!await this.db.one('SELECT id FROM user WHERE id=?', [id]); }
    catch { throw new ApiError(503, '用户身份暂时不可用，请稍后重试', undefined, 'HttpException'); }
  }
  private async current(identity: AdminIdentity): Promise<boolean> {
    if (identity.source === 'password') return equal(identity.username, this.username()) && equal(identity.credentialFingerprint, sha256(this.passwordHash()));
    return identity.source === 'wechat' && Number.isInteger(identity.wechatUserId) && identity.wechatUserId! > 0
      && identity.username === `wechat:${identity.wechatUserId}` && this.isWechatUser(identity.wechatUserId!);
  }
  async user(ctx: Context): Promise<Row | null> {
    const identity = await this.tokens.identity(ctx.req.headers.authorization);
    if (!identity) return null;
    if (!await this.current(identity)) throw new ApiError(401, '管理登录凭据无效或已过期，请重新登录');
    return this.publicUser(identity);
  }
  async scope(ctx: Context): Promise<number | null> {
    const identity = await this.tokens.identity(ctx.req.headers.authorization);
    if (!identity || !await this.current(identity)) throw new ApiError(401, '请先登录设备管理后台');
    return identity.source === 'password' ? null : identity.wechatUserId!;
  }
  private async issue(identity: AdminIdentity): Promise<Row> { return { user: this.publicUser(identity), token: await this.tokens.issue(identity), authMode: 'jwt' }; }
  async login(ctx: Context, cancelTicket: () => Promise<void>): Promise<Row> {
    const { username, password } = ctx.body;
    if (typeof username !== 'string' || typeof password !== 'string' || Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 1024) throw new ApiError(422, '请输入用户名和密码');
    const ip = `${ctx.req.ip ?? 'unknown'}:window:60`, issuer = this.tokens.issuer();
    const attempt = await this.tokens.store.reservePasswordAttempt(ip, 5, 60, issuer);
    if (!attempt.allowed) { ctx.res.setHeader('Retry-After', String(Math.max(1, attempt.retryAfter))); throw new ApiError(429, '登录尝试过于频繁，请稍后重试', undefined, 'HttpException'); }
    const valid = await bcrypt.compare(password, this.passwordHash().replace(/^\$2y\$/, '$2b$'));
    if (!equal(username, this.username()) || !valid) throw new ApiError(401, '用户名或密码错误');
    await this.tokens.store.clearPasswordAttempts(ip, issuer);
    await cancelTicket();
    return this.issue({ source: 'password', username: this.username(), credentialFingerprint: sha256(this.passwordHash()) });
  }
  async refresh(refresh: unknown): Promise<Row> {
    if (typeof refresh !== 'string' || !refresh) throw new ApiError(422, '请提供刷新令牌');
    const result = await this.tokens.refresh(refresh, identity => this.current(identity));
    return { user: this.publicUser(result.identity), token: result.token, authMode: 'jwt' };
  }
  async loginWechat(id: number, cancelTicket: () => Promise<void>): Promise<Row> {
    await this.requireWechatUser(id); await cancelTicket();
    return this.issue({ source: 'wechat', wechatUserId: id, username: `wechat:${id}` });
  }
  async logout(ctx: Context, cancelTicket: () => Promise<void>): Promise<Row> {
    const refresh = ctx.body.refreshToken;
    if (refresh != null && typeof refresh !== 'string') throw new ApiError(422, '刷新令牌格式不正确');
    await cancelTicket(); await this.tokens.revoke(ctx.req.headers.authorization, refresh ?? undefined);
    return { user: null, authMode: 'jwt' };
  }
}
