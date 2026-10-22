import type { Context, Handler, Route } from './contracts';
import { unescape } from 'node:querystring';
export class ApiRouter {
  readonly routes: Route[] = [];
  private readonly compiled: Array<{ route: Route; regex: RegExp; names: string[] }> = [];
  add(method: string | string[], path: string, handler: Handler): void {
    for (const verb of Array.isArray(method) ? method : [method]) {
      if (this.routes.some(route => route.method === verb.toUpperCase() && route.path === path)) throw new Error(`Duplicate route: ${verb} ${path}`);
      const route = { method: verb.toUpperCase(), path, handler };
      const names: string[] = [];
      const pattern = path.split('/').map(part => {
        if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const name = part.slice(1); names.push(name);
        if (path.includes('/tickets/') && name === 'id') return '([a-f0-9]{32})';
        if (path.startsWith('/admin-api/') && name === 'id') return '(\\d+)';
        return name === 'id' ? '(\\d[\\d,]*)' : '([^/]+)';
      }).join('/');
      this.routes.push(route);
      this.compiled.push({ route, regex: new RegExp(`^${pattern}$`), names });
    }
  }
  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    // Yii Request decodes the whole path before UrlRule matching. In particular,
    // encoded slashes are separators, and a literal plus becomes a space.
    path = unescape(path.replace(/\+/g, ' '));
    const candidates = this.compiled.filter(item => item.route.method === method);
    // Yii REST extraPatterns take precedence over /:id regardless of registration order.
    candidates.sort((a, b) => a.names.length - b.names.length);
    for (const item of candidates) {
      const match = item.regex.exec(path);
      if (match) return { route: item.route, params: Object.fromEntries(item.names.map((name, i) => [name, match[i + 1]])) };
    }
    return null;
  }
  async dispatch(context: Context): Promise<unknown> {
    const match = this.match(context.req.method, context.req.path);
    if (!match) return undefined;
    context.params = match.params;
    return match.route.handler(context);
  }
}
