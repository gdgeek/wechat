import type { Context, Row, Services } from './contracts';
/** Diagnostic APIs retain their payload shape; credentials are never echoed. */
export async function recordRequest(s: Services, ctx: Context, action: string, key = 'log_cache'): Promise<void> {
  const sensitive = /^(authorization|cookie|set-cookie|password|refreshToken|secret)$/i;
  const headers = Object.fromEntries(Object.entries(ctx.req.headers).map(([name, value]) => [name, sensitive.test(name) ? ['[redacted]'] : Array.isArray(value) ? value : [String(value)]]));
  const redact = (data: Row) => Object.keys(data).length === 0 ? [] : Object.fromEntries(Object.entries(data).map(([name, value]) => [name, sensitive.test(name) ? '[redacted]' : value]));
  const payload = { action, isGet: ctx.req.method === 'GET', post: redact(ctx.body), get: redact(ctx.query), headers };
  await s.redis.save('wechat_diagnostic', { token: key, data: JSON.stringify(payload) });
}
export async function readRequest(s: Services, key = 'log_cache'): Promise<Row | false> {
  const row = await s.redis.find('wechat_diagnostic', key);
  if (!row?.data) return false;
  try { return typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch { return false; }
}
