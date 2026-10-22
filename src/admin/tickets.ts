import { randomBytes } from 'node:crypto';
import type { Context, Row, Services } from '../core/contracts';
import { ApiError } from '../core/errors';
import { type BrowserState, equal, sha256, throttle } from './sessions';
export function canonicalOrigin(value = process.env.ADMIN_SCAN_LOGIN_ORIGIN || ''): string | null {
  if (typeof value !== 'string' || value.length > 255 || !/^https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::[1-9][0-9]{0,4})?$/.test(value)) return null;
  try { const url = new URL(value); return url.origin === value ? value : null; } catch { return null; }
}
export class ScanTickets {
  constructor(private readonly s: Services) {}
  enabled(): boolean { return canonicalOrigin() !== null; }
  private origin(): string { const origin = canonicalOrigin(); if (!origin) throw new ApiError(503, '扫码登录尚未配置'); return origin; }
  private async ticket(id: string): Promise<Row> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new ApiError(404, '二维码不存在');
    await this.s.db.execute("UPDATE admin_scan_login_ticket SET status='expired' WHERE id=? AND status IN ('pending','approved') AND expires_at<=?", [id, Math.floor(Date.now() / 1000)]);
    const row = await this.s.db.one('SELECT * FROM admin_scan_login_ticket WHERE id=?', [id]);
    if (!row) throw new ApiError(404, '二维码不存在');
    return row;
  }
  private owned(row: Row, state: BrowserState): void { if (!state.owner || !equal(row.owner_hash, sha256(state.owner))) throw new ApiError(404, '二维码不存在'); }
  private audience(row: Row): void { if (!equal(row.audience, this.origin())) throw new ApiError(403, '二维码目标环境不匹配'); }
  private requireState(row: Row, expected: string): void { if (row.status === 'expired') throw new ApiError(410, '二维码已过期，请刷新'); if (row.status !== expected) throw new ApiError(409, '二维码未确认、已使用或已取消'); }
  private state(row: Row): Row { return { status: row.status, expiresAt: new Date(Number(row.expires_at) * 1000).toISOString() }; }
  async cancelCurrent(state: BrowserState): Promise<void> {
    if (state.currentTicket && state.owner) await this.s.db.execute("UPDATE admin_scan_login_ticket SET status='cancelled' WHERE id=? AND owner_hash=? AND status IN ('pending','approved')", [state.currentTicket, sha256(state.owner)]);
    delete state.currentTicket;
  }
  async create(ctx: Context, state: BrowserState): Promise<Row> {
    const origin = this.origin();
    await throttle(this.s.db, ctx, `scan:create:${ctx.req.ip}`, 15, 60);
    state.owner ||= randomBytes(32).toString('hex');
    const id = randomBytes(16).toString('hex'), secret = randomBytes(32).toString('hex'), now = Math.floor(Date.now() / 1000);
    await this.s.db.transaction(async db => {
      if (state.currentTicket) await db.execute("UPDATE admin_scan_login_ticket SET status='cancelled' WHERE id=? AND owner_hash=? AND status IN ('pending','approved')", [state.currentTicket, sha256(state.owner!)]);
      await db.execute('DELETE FROM admin_scan_login_ticket WHERE expires_at<=?', [now - 86400]);
      await db.execute("UPDATE admin_scan_login_ticket SET status='expired' WHERE status IN ('pending','approved') AND expires_at<=?", [now]);
      await db.insert('admin_scan_login_ticket', { id, secret_hash: sha256(secret), owner_hash: sha256(state.owner!), audience: origin, status: 'pending', created_at: now, expires_at: now + 300 });
    });
    state.currentTicket = id;
    return { ticketId: id, qrText: `bujiaban-admin-login://v1/${id}?secret=${secret}&origin=${encodeURIComponent(origin)}`, expiresAt: new Date((now + 300) * 1000).toISOString() };
  }
  async status(id: string, state: BrowserState): Promise<Row> { const row = await this.ticket(id); this.owned(row, state); this.audience(row); return this.state(row); }
  async approve(ctx: Context): Promise<Row> {
    this.origin();
    const user = await this.s.auth.bearer(ctx, 'v2-user');
    await throttle(this.s.db, ctx, `scan:approve:${user.id}:${ctx.req.ip}`, 30, 60);
    const row = await this.ticket(ctx.params.id);
    this.audience(row);
    if (typeof ctx.body.secret !== 'string' || !/^[a-f0-9]{64}$/.test(ctx.body.secret) || !equal(row.secret_hash, sha256(ctx.body.secret))) throw new ApiError(403, '无效的扫码登录凭据');
    this.requireState(row, 'pending');
    const now = Math.floor(Date.now() / 1000);
    const result = await this.s.db.execute("UPDATE admin_scan_login_ticket SET status='approved',approved_user_id=?,approved_at=? WHERE id=? AND status='pending' AND audience=? AND expires_at>?", [user.id, now, row.id, this.origin(), now]);
    if (result.affectedRows !== 1) throw new ApiError(409, '二维码状态已变化，请刷新');
    return { status: 'approved' };
  }
  async consume(id: string, state: BrowserState): Promise<Row> {
    this.origin();
    const row = await this.ticket(id);
    this.owned(row, state); this.audience(row); this.requireState(row, 'approved');
    if (state.currentTicket !== id) throw new ApiError(409, '二维码已被刷新');
    const userId = Number(row.approved_user_id);
    if (!await this.s.db.one('SELECT id FROM user WHERE id=?', [userId])) throw new ApiError(403, '微信账号已失效，请重新登录');
    const now = Math.floor(Date.now() / 1000);
    const changed = await this.s.db.execute("UPDATE admin_scan_login_ticket SET status='consumed',consumed_at=? WHERE id=? AND status='approved' AND owner_hash=? AND audience=? AND approved_user_id=? AND expires_at>?", [now, id, row.owner_hash, this.origin(), userId, now]);
    if (changed.affectedRows !== 1) throw new ApiError(409, '二维码已使用或已过期');
    delete state.currentTicket;
    state.identity = { source: 'wechat', username: `wechat:${userId}`, wechatUserId: userId, expiresAt: now + 28800 };
    state.rotate = true;
    return { username: state.identity.username, role: 'device_manager' };
  }
  async cancel(id: string, state: BrowserState): Promise<Row> {
    const row = await this.ticket(id); this.owned(row, state); this.audience(row);
    await this.s.db.execute("UPDATE admin_scan_login_ticket SET status='cancelled' WHERE id=? AND status IN ('pending','approved')", [id]);
    if (state.currentTicket === id) delete state.currentTicket;
    return this.state(await this.ticket(id));
  }
}
