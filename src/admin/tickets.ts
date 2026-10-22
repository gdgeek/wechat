import { randomBytes } from 'node:crypto';
import type { Context, Row, Services } from '../core/contracts';
import { ApiError } from '../core/errors';
import { equal, sha256, throttle } from './sessions';
import { AdminAuth } from './auth';

export function canonicalOrigin(value = process.env.ADMIN_SCAN_LOGIN_ORIGIN || ''): string | null {
  if (typeof value !== 'string' || value.length > 255 || !/^https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::[1-9][0-9]{0,4})?$/.test(value)) return null;
  try { const url = new URL(value); return url.origin === value ? value : null; } catch { return null; }
}

/** QR owners are supplied by the existing Vue client's X-Admin-Scan-Owner. */
export class ScanTickets {
  constructor(private readonly s: Services, private readonly auth: AdminAuth) {}
  enabled(): boolean { return canonicalOrigin() !== null; }
  private origin(): string { const origin = canonicalOrigin(); if (!origin) throw new ApiError(503, '扫码登录尚未配置', undefined, 'HttpException'); return origin; }
  private now(): number { return Math.floor(Date.now() / 1000); }
  private owner(ctx: Context, required = true): string | null {
    const proof = ctx.req.headers['x-admin-scan-owner'];
    if (typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof)) return sha256(proof);
    if (required) throw new ApiError(400, '扫码浏览器凭据无效', undefined, 'HttpException');
    return null;
  }
  private async database<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, '扫码登录暂时不可用，请稍后重试', undefined, 'HttpException'); }
  }
  private async ticket(id: string): Promise<Row> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new ApiError(404, '二维码不存在', undefined, 'HttpException');
    await this.s.db.execute("UPDATE admin_scan_login_ticket SET status='expired' WHERE id=? AND status IN ('pending','approved') AND expires_at<=?", [id, this.now()]);
    const row = await this.s.db.one('SELECT * FROM admin_scan_login_ticket WHERE id=?', [id]);
    if (!row) throw new ApiError(404, '二维码不存在', undefined, 'HttpException');
    return row;
  }
  private owned(row: Row, ownerHash: string): void { if (!equal(row.owner_hash, ownerHash)) throw new ApiError(404, '二维码不存在', undefined, 'HttpException'); }
  private audience(row: Row): void { const origin = canonicalOrigin(); if (!origin || !equal(row.audience, origin)) throw new ApiError(403, '二维码目标环境不匹配', undefined, 'HttpException'); }
  private requireState(row: Row, expected: string): void {
    if (row.status === 'expired') throw new ApiError(410, '二维码已过期，请刷新', undefined, 'HttpException');
    if (row.status !== expected) throw new ApiError(409, '二维码未确认、已使用或已取消', undefined, 'HttpException');
  }
  private state(row: Row): Row { return { status: row.status, expiresAt: new Date(Number(row.expires_at) * 1000).toISOString().replace('.000Z', '+00:00') }; }
  async cancelCurrent(ctx: Context): Promise<void> {
    const ownerHash = this.owner(ctx, false), origin = canonicalOrigin();
    if (!ownerHash || !origin) return;
    await this.auth.tokens.store.withOwnerLock(ownerHash, () => this.database(() => this.s.db.transaction(async db => {
      await db.execute("UPDATE admin_scan_login_ticket SET status='cancelled' WHERE owner_hash=? AND audience=? AND status IN ('pending','approved') AND expires_at>?", [ownerHash, origin, this.now()]);
      await this.auth.tokens.store.assertOwnerLock(ownerHash);
    })));
  }
  async create(ctx: Context): Promise<Row> {
    const origin = this.origin(), ownerHash = this.owner(ctx)!;
    await throttle(this.s.db, ctx, `scan:create:${ctx.req.ip ?? 'unknown'}`, 15, 60);
    const id = randomBytes(16).toString('hex'), secret = randomBytes(32).toString('hex'), now = this.now();
    await this.auth.tokens.store.withOwnerLock(ownerHash, () => this.database(() => this.s.db.transaction(async db => {
      await db.execute("UPDATE admin_scan_login_ticket SET status='cancelled' WHERE owner_hash=? AND audience=? AND status IN ('pending','approved') AND expires_at>?", [ownerHash, origin, now]);
      await db.execute('DELETE FROM admin_scan_login_ticket WHERE expires_at<=?', [now - 86400]);
      await db.execute("UPDATE admin_scan_login_ticket SET status='expired' WHERE status IN ('pending','approved') AND expires_at<=?", [now]);
      await db.insert('admin_scan_login_ticket', { id, secret_hash: sha256(secret), owner_hash: ownerHash, audience: origin, status: 'pending', created_at: now, expires_at: now + 300 });
      await this.auth.tokens.store.assertOwnerLock(ownerHash);
    })));
    return { ticketId: id, qrText: `bujiaban-admin-login://v1/${id}?secret=${secret}&origin=${encodeURIComponent(origin)}`, expiresAt: new Date((now + 300) * 1000).toISOString().replace('.000Z', '+00:00') };
  }
  async status(ctx: Context): Promise<Row> {
    const ownerHash = this.owner(ctx)!;
    return this.database(async () => { const row = await this.ticket(ctx.params.id); this.owned(row, ownerHash); this.audience(row); return this.state(row); });
  }
  async approve(ctx: Context, user: Row): Promise<Row> {
    this.origin();
    await throttle(this.s.db, ctx, `scan:approve:${user.id}:${ctx.req.ip ?? 'unknown'}`, 30, 60);
    await this.auth.requireWechatUser(Number(user.id));
    return this.database(() => this.s.db.transaction(async db => {
      const row = await this.ticket(ctx.params.id);
      this.audience(row);
      if (typeof ctx.body.secret !== 'string' || !/^[a-f0-9]{64}$/.test(ctx.body.secret) || !equal(row.secret_hash, sha256(ctx.body.secret))) throw new ApiError(403, '无效的扫码登录凭据', undefined, 'HttpException');
      this.requireState(row, 'pending');
      await this.auth.requireWechatUser(Number(user.id));
      const now = this.now();
      const changed = await db.execute("UPDATE admin_scan_login_ticket SET status='approved',approved_user_id=?,approved_at=? WHERE id=? AND status='pending' AND audience=? AND expires_at>?", [user.id, now, row.id, this.origin(), now]);
      if (changed.affectedRows !== 1) throw new ApiError(409, '二维码状态已变化，请刷新', undefined, 'HttpException');
      return { status: 'approved' };
    }));
  }
  async consume(ctx: Context): Promise<Row> {
    this.origin();
    const ownerHash = this.owner(ctx)!;
    const userId = await this.auth.tokens.store.withOwnerLock(ownerHash, () => this.database(() => this.s.db.transaction(async db => {
      const row = await this.ticket(ctx.params.id);
      this.owned(row, ownerHash); this.audience(row); this.requireState(row, 'approved');
      const userId = Number(row.approved_user_id); await this.auth.requireWechatUser(userId);
      const now = this.now();
      const changed = await db.execute("UPDATE admin_scan_login_ticket SET status='consumed',consumed_at=? WHERE id=? AND status='approved' AND owner_hash=? AND audience=? AND approved_user_id=? AND expires_at>?", [now, row.id, ownerHash, this.origin(), userId, now]);
      if (changed.affectedRows !== 1) throw new ApiError(409, '二维码已使用或已过期', undefined, 'HttpException');
      await this.auth.tokens.store.assertOwnerLock(ownerHash);
      return userId;
    })));
    return this.auth.loginWechat(userId, () => this.cancelCurrent(ctx));
  }
  async cancel(ctx: Context): Promise<Row> {
    const ownerHash = this.owner(ctx)!;
    return this.auth.tokens.store.withOwnerLock(ownerHash, () => this.database(() => this.s.db.transaction(async db => {
      const row = await this.ticket(ctx.params.id); this.owned(row, ownerHash); this.audience(row);
      await db.execute("UPDATE admin_scan_login_ticket SET status='cancelled' WHERE id=? AND owner_hash=? AND audience=? AND status IN ('pending','approved')", [row.id, ownerHash, this.origin()]);
      const result = this.state(await this.ticket(ctx.params.id));
      await this.auth.tokens.store.assertOwnerLock(ownerHash);
      return result;
    })));
  }
}
