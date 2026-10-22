import { ApiError } from '../core/errors';
import type { Context, Row } from '../core/contracts';
export function sceneBaseUrl(configured = process.env.SCENE_SERVER_BASE_URL || 'https://y1.b0.01xr.com/v1/server'): string {
  const value = configured.trim().replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid SCENE_SERVER_BASE_URL'); }
  const path = url.pathname.replace(/\/+$/, '');
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === 'y1-p' && url.port === '8080') || url.username || url.password || url.search || url.hash || path !== '' && path !== '/v1/server') throw new Error('Invalid SCENE_SERVER_BASE_URL');
  return path === '' ? `${value}/v1/server` : value;
}
function unwrap(input: unknown): Row[] {
  for (let depth = 0; depth <= 5; depth++) {
    if (Array.isArray(input)) return input;
    if (!input || typeof input !== 'object') break;
    const value = input as Row;
    const key = ['data', 'items', 'results'].find(field => value[field] && typeof value[field] === 'object');
    if (!key) break;
    input = value[key];
  }
  throw new Error('Invalid scene list');
}
export class SceneCatalog {
  private cached?: { until: number; games: Row[] };
  private forwarded?: { until: number; payload: unknown };
  constructor(private readonly options: { baseUrl?: string; fetch?: typeof fetch; perPage?: number; maxPages?: number; timeoutMs?: number; now?: () => number } = {}) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  async forwardCheckin(ctx: Context): Promise<unknown> {
    if (this.forwarded && this.forwarded.until > this.now()) return this.forwarded.payload;
    try {
      const response = await (this.options.fetch ?? fetch)(`${sceneBaseUrl(this.options.baseUrl)}/checkin?expand=verse_id,name`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
      ctx.res.status(response.status);
      const text = await response.text();
      try {
        const payload: unknown = JSON.parse(text);
        if (response.ok) this.forwarded = { until: this.now() + 30000, payload };
        return payload;
      } catch { ctx.res.type('text/plain'); return text; }
    } catch { throw new ApiError(500, '转发请求失败'); }
  }
  async fetchScenes(): Promise<Row[]> {
    const base = sceneBaseUrl(this.options.baseUrl);
    const perPage = this.options.perPage ?? 15, maxPages = this.options.maxPages ?? 100;
    const deadline = this.now() + (this.options.timeoutMs ?? 15000);
    let pages = 1, first: Record<string, number | null> | undefined;
    const items: Row[] = [];
    for (let page = 1; page <= Math.max(1, pages); page++) {
      const remaining = Math.ceil(deadline - this.now());
      if (remaining <= 0) throw new Error('Scene request deadline exceeded');
      const url = new URL(`${base}/checkin`);
      url.search = new URLSearchParams({ expand: 'verse_id,name', page: String(page), pageSize: String(perPage) }).toString();
      const response = await (this.options.fetch ?? fetch)(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(remaining) });
      if (!response.ok || this.now() >= deadline) throw new Error('Scene service unavailable');
      items.push(...unwrap(await response.json()));
      const meta: Record<string, number | null> = {};
      for (const suffix of ['page-count', 'total-count', 'per-page']) {
        const header = response.headers.get(`x-pagination-${suffix}`);
        if (header !== null && (!/^\d+$/.test(header.trim()) || !Number.isSafeInteger(Number(header)) || suffix === 'per-page' && Number(header) < 1)) throw new Error('Invalid scene pagination');
        meta[suffix] = header === null ? null : Number(header);
      }
      const derived = meta['total-count'] === 0 ? 0 : meta['total-count'] !== null && meta['per-page'] !== null ? Math.ceil(meta['total-count'] / meta['per-page']) : null;
      if (derived !== null) { if (meta['page-count'] !== null && meta['page-count'] !== derived) throw new Error('Inconsistent scene pagination'); meta['page-count'] = derived; }
      if (meta['page-count'] === null && (meta['per-page'] !== null || meta['total-count'] !== null)) throw new Error('Incomplete scene pagination');
      if (!first) { first = meta; pages = meta['page-count'] ?? 1; if (pages > maxPages) throw new Error('Scene page limit exceeded'); }
      else for (const key of Object.keys(meta)) if (first[key] !== null && meta[key] !== null && first[key] !== meta[key]) throw new Error('Scene pagination changed');
    }
    if (first!['total-count'] !== null && items.length !== first!['total-count'] || pages === 0 && items.length || this.now() >= deadline) throw new Error('Incomplete scene catalog');
    return items;
  }
  async getGames(): Promise<Row[]> {
    if (this.cached && this.cached.until > this.now()) return this.cached.games;
    try {
      const rows = await this.fetchScenes();
      const games = new Map<number, Row>();
      for (const scene of rows) {
        const id = typeof scene?.verse_id === 'number' || typeof scene?.verse_id === 'string' && /^[1-9]\d*$/.test(scene.verse_id) ? Number(scene.verse_id) : NaN;
        if (!Number.isSafeInteger(id) || id <= 0 || typeof scene.name !== 'string' || !scene.name.trim()) continue;
        games.set(id, { id, name: scene.name, description: typeof scene.description === 'string' ? scene.description : '', category: typeof scene.category === 'string' ? scene.category : '' });
      }
      if (rows.length && !games.size) throw new Error('Scene list has no valid scenes');
      const result = [...games.values()];
      this.cached = { until: this.now() + 30000, games: result };
      return result;
    } catch { throw new ApiError(503, '游戏列表暂时不可用，请稍后重试'); }
  }
}
