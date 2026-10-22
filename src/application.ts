import 'reflect-metadata';
import { All, Controller, Inject, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import express, { type Request, type Response } from 'express';
import { parse as parseQuery } from 'qs';
import { dirname } from 'node:path';
import { Database } from './core/database';
import { adminRedisOptions, LegacyRedis } from './core/redis';
import { AuthService } from './core/auth';
import { ApiRouter } from './core/router';
import { ApiError, errorPayload } from './core/errors';
import { xmlResponse } from './core/serialization';
import type { Context, Services } from './core/contracts';
import { SceneCatalog } from './admin/scenes';
import { equal } from './admin/sessions';
import { registerAdmin } from './admin';
import { Integrations, registerIntegrations } from './integrations/integrations';
import { registerV1 } from './v1';
import { registerV2 } from './v2';

export function createServices(): Services {
  const db = new Database();
  return { db, redis: new LegacyRedis(), adminAuthRedis: new LegacyRedis(adminRedisOptions()), auth: new AuthService(db), catalog: new SceneCatalog(), integrations: new Integrations() };
}
export function createRouter(s: Services): ApiRouter {
  const router = new ApiRouter();
  registerAdmin(router, s); registerV1(router, s); registerV2(router, s); registerIntegrations(router, s);
  for (const resource of ['devices', 'setups', 'files']) {
    for (const path of [`/v2/${resource}`, `/v2/${resource}/:id`]) {
      const get = router.routes.find(route => route.method === 'GET' && route.path === path)!;
      router.add('HEAD', path, get.handler);
    }
    for (const item of [false, true]) router.add('OPTIONS', `/v2/${resource}${item ? '/:id' : ''}`, ctx => {
      const allow = item ? 'GET, PUT, PATCH, DELETE, HEAD, OPTIONS' : 'GET, POST, HEAD, OPTIONS';
      ctx.res.setHeader('Allow', allow);
      ctx.res.setHeader('Access-Control-Allow-Methods', allow);
      return null;
    });
  }
  // Yii's rule resolves this action before OptionsAction, then FileController
  // removes it. Preserve the resulting 404, rather than a generic 405 fallback.
  router.add('DELETE', '/v2/files/:id', () => { throw new ApiError(404, 'Page not found.'); });
  const swaggerAuth = (ctx: import('./core/contracts').Context) => {
    if (!process.env.SWAGGER_USERNAME || !process.env.SWAGGER_PASSWORD) throw new ApiError(500, 'Swagger 配置未找到');
    const header = ctx.req.headers.authorization;
    let credentials = '';
    if (typeof header === 'string' && header.startsWith('Basic ')) credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
    if (!equal(credentials, `${process.env.SWAGGER_USERNAME}:${process.env.SWAGGER_PASSWORD}`)) { ctx.res.setHeader('WWW-Authenticate', 'Basic realm="Swagger API Documentation"'); ctx.res.status(401).type('html').send('需要认证才能访问 API 文档'); return false; }
    return true;
  };
  router.add(['GET', 'HEAD'], '/health', async ctx => {
    const checks: Record<string, unknown> = {};
    async function check(name: string, operation: () => Promise<unknown>, validate?: (value: unknown) => boolean): Promise<void> {
      const start = performance.now();
      try { const value = await operation(); const valid = !validate || validate(value); checks[name] = { status: valid ? 'up' : 'down', responseTime: Math.round(performance.now() - start), ...(!valid ? { error: 'Unexpected PING response' } : {}) }; }
      catch { checks[name] = { status: 'down', responseTime: Math.round(performance.now() - start), error: 'Service unavailable' }; }
    }
    await Promise.all([check('database', () => s.db.query('SELECT 1')), ...(process.env.HEALTH_REDIS === '0' ? [] : [check('redis', () => s.redis.ping(), value => value === 'PONG' || value === true)])]);
    const healthy = Object.values(checks).every((value: any) => value.status === 'up');
    ctx.res.status(healthy ? 200 : 503).setHeader('Cache-Control', 'no-store');
    const buildTime = process.env.BUILD_TIME?.trim();
    const isoBuildTime = buildTime && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(buildTime) && Number.isFinite(Date.parse(buildTime));
    const version = isoBuildTime ? new Date(Date.parse(buildTime!) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : buildTime;
    return { status: healthy ? 'healthy' : 'unhealthy', timestamp: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19) + '+08:00', checks, ...(process.env.GIT_COMMIT ? { gitCommit: process.env.GIT_COMMIT } : {}), ...(version ? { version } : {}) };
  });
  router.add('GET', '/swagger/json-schema', ctx => { if (!swaggerAuth(ctx)) return; return { openapi: '3.0.3', info: { title: 'gdgeek game compatible API', version: '1.0.0' }, paths: Object.fromEntries([...new Set(router.routes.map(route => route.path))].map(path => [path.replace(/:([a-z_]+)/g, '{$1}'), Object.fromEntries(router.routes.filter(route => route.path === path && route.method !== 'HEAD').map(route => [route.method.toLowerCase(), { summary: `${route.method} ${path}`, parameters: [...path.matchAll(/:([a-z_]+)/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } })), responses: { 200: { description: 'Legacy-compatible response' } } }]))])) }; });
  router.add('GET', '/swagger', ctx => { if (!swaggerAuth(ctx)) return; ctx.res.type('html'); return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>API 文档</title><link rel="stylesheet" href="/swagger-ui/swagger-ui.css"></head><body style="margin:0"><div id="swagger-ui"></div><script src="/swagger-ui/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/swagger/json-schema",dom_id:"#swagger-ui",deepLinking:true})</script></body></html>'; });
  return router;
}

type ResponseFormat = 'html' | 'json' | 'xml';
type CompatibilityRequest = Request & { bodyError?: ApiError; rawBody?: Buffer };

function negotiateFormat(req: Request, res: Response, select: (format: ResponseFormat) => void): void {
  res.vary('Accept');
  const explicit = req.query._format;
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== 'string') throw new ApiError(400, "Invalid data received for GET parameter '_format'.");
    if (explicit !== 'json' && explicit !== 'xml') throw new ApiError(406, `The requested response format is not supported: ${explicit}`);
    select(explicit); return;
  }
  const accepts = (req.get('Accept') || '*/*').split(',').map((part, index) => {
    const [type, ...params] = part.trim().split(/\s*;\s*/);
    return { type, index, quality: Number(params.find(param => param.startsWith('q='))?.slice(2) ?? 1) };
  }).sort((a, b) => b.quality - a.quality || Number(a.type.endsWith('*')) - Number(b.type.endsWith('*')) || a.index - b.index);
  for (const accept of accepts) {
    if (accept.type === 'application/json' || accept.type === 'application/xml') {
      select(accept.type === 'application/json' ? 'json' : 'xml'); return;
    }
  }
  // Yii picks its first format before throwing for an unsupported Accept value.
  select('json');
  if (!accepts.some(accept => accept.type === '*/*' || accept.type === '')) throw new ApiError(406, 'None of your requested content types is supported.');
}

function escapeMarkup(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]!));
}

function sendResult(req: Request, res: Response, result: unknown, format: ResponseFormat): void {
  const contentType = String(res.getHeader('Content-Type') ?? '');
  if (/application\/json/i.test(contentType)) format = 'json';
  else if (/application\/xml/i.test(contentType)) format = 'xml';
  else if (contentType && typeof result === 'string') { res.send(result); return; }
  if (res.statusCode === 204) { res.end(); return; }
  res.type(format === 'xml' ? 'application/xml' : format === 'json' ? 'application/json' : 'text/html');
  if (req.method === 'HEAD') { res.end(); return; }
  if (format === 'xml') res.send(xmlResponse(result));
  else if (format === 'json') res.json(result === undefined ? null : result);
  else res.send(result === undefined || result === null ? '' : String(result));
}

function htmlError(body: any, res: Response): string {
  // Yii's site/error layout reads session flashes, which emits PHP's nocache
  // headers. Preserve the cache policy without creating a session or cookie.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Expires', 'Thu, 19 Nov 1981 08:52:00 GMT');
  res.setHeader('Pragma', 'no-cache');
  const title = escapeMarkup(`${body.name} (#${body.status})`);
  return `<!DOCTYPE html>\n<html lang="en-US"><head><meta charset="UTF-8"><title>${title}</title></head><body><main class="site-error"><h1>${title}</h1><div class="alert alert-danger">${escapeMarkup(body.message).replace(/\n/g, '<br>')}</div><p>The above error occurred while the Web server was processing your request.</p><p>Please contact us if you think this is a server error. Thank you.</p></main></body></html>`;
}

function applyCors(req: Request, res: Response): void {
  if (req.headers.origin !== undefined) res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'X-Pagination-Total-Count, X-Pagination-Page-Count, X-Pagination-Current-Page, X-Pagination-Per-Page');
  if (req.headers['access-control-request-method'] !== undefined) res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  const headers = req.get('Access-Control-Request-Headers');
  if (headers !== undefined) res.setHeader('Access-Control-Allow-Headers', headers.split(/[\s,]+/).filter(Boolean).map(header => header.toLowerCase().replace(/(^|[-_])\w/g, letter => letter.replace('_', '-').toUpperCase())).join(', '));
  if (req.method === 'OPTIONS') res.setHeader('Access-Control-Max-Age', '86400');
}

@Controller()
class CompatibilityController {
  constructor(@Inject('API_ROUTER') private readonly router: ApiRouter) {}
  @All('{*path}')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    let format: ResponseFormat = 'html';
    let resolvedPath = '';
    applyCors(req, res);
    try {
      const match = this.router.match(req.method, req.path);
      const options = !match ? this.router.match('OPTIONS', req.path) : null;
      const resolved = match ?? options;
      // FileController removes these actions before any controller filters run.
      const removedFileAction = match && (match.route.path === '/v2/files' && req.method === 'POST' || match.route.path === '/v2/files/:id' && ['PUT', 'PATCH', 'DELETE'].includes(req.method));
      if (!resolved || removedFileAction) throw new ApiError(404, 'Page not found.');
      resolvedPath = resolved.route.path;
      if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined) {
        sendResult(req, res, '', 'html'); return;
      }
      if (resolvedPath.startsWith('/admin-api/') || resolvedPath.startsWith('/v2/web-login/')) format = 'json';
      if (/^\/v[12]\//.test(resolvedPath)) negotiateFormat(req, res, selected => { format = selected; });
      else if (resolvedPath === '/health' || resolvedPath === '/swagger/json-schema') format = 'json';
      // Yii parses bodyParams only when the action asks for them, after routing,
      // content negotiation and authentication. Keep raw bytes for payment signing.
      const context: Context = { req, res, query: req.query, params: resolved.params,
        get body() { if ((req as CompatibilityRequest).bodyError) throw (req as CompatibilityRequest).bodyError; return req.body ?? {}; } };
      if (options) res.status(405);
      const result = await resolved.route.handler(context);
      if (res.headersSent) return;
      sendResult(req, res, result, format);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const isAdminDatabaseError = (resolvedPath.startsWith('/admin-api/') || resolvedPath.startsWith('/v2/web-login/')) && !!(error as any)?.sqlState;
      const result = errorPayload(isAdminDatabaseError ? new ApiError(503, '服务暂时不可用，请稍后重试') : error);
      res.status(result.status);
      sendResult(req, res, format === 'html' ? htmlError(result.body, res) : result.body, format);
    }
  }
}

export async function createApplication(services = createServices()): Promise<INestApplication> {
  const router = createRouter(services);
  @Module({ controllers: [CompatibilityController], providers: [{ provide: 'API_ROUTER', useValue: router },
    { provide: 'ADMIN_REDIS_LIFECYCLE', useValue: { onModuleDestroy: () => services.adminAuthRedis?.close() } }] })
  class ApplicationModule {}
  const app = await NestFactory.create(ApplicationModule, { logger: process.env.NODE_ENV === 'test' ? false : ['error', 'warn', 'log'], bodyParser: false });
  const server = app.getHttpAdapter().getInstance() as express.Express;
  server.disable('x-powered-by');
  server.set('query parser', (value: string) => parseQuery(value, { duplicates: 'last' }));
  server.use('/swagger-ui', express.static(dirname(require.resolve('swagger-ui-dist/swagger-ui-bundle.js'))));
  if (process.env.TRUST_PROXY) server.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : process.env.TRUST_PROXY);
  const verify = (req: Request, _res: Response, buffer: Buffer) => { (req as any).rawBody = buffer; };
  app.use(express.json({ limit: '2mb', verify, strict: false }));
  app.use(express.urlencoded({ extended: true, limit: '2mb', verify }));
  app.use((error: any, req: CompatibilityRequest, res: Response, next: express.NextFunction) => {
    if (error?.type === 'entity.parse.failed') { req.bodyError = new ApiError(400, 'Invalid JSON data in request body: Syntax error'); next(); }
    else if (error?.status === 413) { const result = errorPayload(new ApiError(413, 'Request entity too large.')); res.status(result.status).json(result.body); }
    else next(error);
  });
  app.use((req: Request, _res: Response, next: express.NextFunction) => {
    if (req.is('application/x-www-form-urlencoded') && (req as CompatibilityRequest).rawBody) req.body = parseQuery((req as CompatibilityRequest).rawBody!.toString('utf8'), { duplicates: 'last' });
    const form = req.method === 'POST' && req.is('application/x-www-form-urlencoded') ? req.body?._method : undefined;
    if (typeof form === 'string' && !['GET', 'HEAD', 'OPTIONS'].includes(form.toUpperCase())) req.method = form.toUpperCase();
    else if (req.get('X-Http-Method-Override')) req.method = req.get('X-Http-Method-Override')!.toUpperCase();
    if (form !== undefined) delete req.body._method;
    next();
  });
  await app.init();
  return app;
}
