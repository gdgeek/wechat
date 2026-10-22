import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
export const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');
export function equal(left: unknown, right: unknown): boolean { return typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
/** SQL scan limits are recorded before entering the ticket state transaction. */
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
