import 'reflect-metadata';
import { All, Controller, Inject, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import express, { type Request, type Response } from 'express';
import { dirname } from 'node:path';
import { Database } from './core/database';
import { adminRedisOptions, LegacyRedis } from './core/redis';
import { AuthService } from './core/auth';
import { ApiRouter } from './core/router';
import { ApiError, errorPayload } from './core/errors';
import type { Services } from './core/contracts';
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
    if (!equal(credentials, `${process.env.SWAGGER_USERNAME}:${process.env.SWAGGER_PASSWORD}`)) { ctx.res.setHeader('WWW-Authenticate', 'Basic realm="Swagger API Documentation"'); throw new ApiError(401, '需要认证才能访问 API 文档'); }
  };
  router.add(['GET', 'HEAD'], '/health', async ctx => {
    const checks: Record<string, unknown> = {};
    async function check(name: string, operation: () => Promise<unknown>): Promise<void> {
      const start = performance.now();
      try { await operation(); checks[name] = { status: 'up', responseTime: Math.round(performance.now() - start) }; }
      catch { checks[name] = { status: 'down', responseTime: Math.round(performance.now() - start), error: 'Service unavailable' }; }
    }
    await Promise.all([check('database', () => s.db.query('SELECT 1')), ...(process.env.HEALTH_REDIS === '0' ? [] : [check('redis', () => s.redis.ping())])]);
    const healthy = Object.values(checks).every((value: any) => value.status === 'up');
    ctx.res.status(healthy ? 200 : 503).setHeader('Cache-Control', 'no-store');
    return { status: healthy ? 'healthy' : 'unhealthy', timestamp: new Date().toISOString(), checks, ...(process.env.GIT_COMMIT ? { gitCommit: process.env.GIT_COMMIT } : {}), ...(process.env.BUILD_TIME ? { version: process.env.BUILD_TIME } : {}) };
  });
  router.add('GET', '/swagger/json-schema', ctx => { swaggerAuth(ctx); return { openapi: '3.0.3', info: { title: 'gdgeek game compatible API', version: '1.0.0' }, paths: Object.fromEntries([...new Set(router.routes.map(route => route.path))].map(path => [path.replace(/:([a-z_]+)/g, '{$1}'), Object.fromEntries(router.routes.filter(route => route.path === path && route.method !== 'HEAD').map(route => [route.method.toLowerCase(), { summary: `${route.method} ${path}`, parameters: [...path.matchAll(/:([a-z_]+)/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } })), responses: { 200: { description: 'Legacy-compatible response' } } }]))])) }; });
  router.add('GET', '/swagger', ctx => { swaggerAuth(ctx); ctx.res.type('html'); return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>API 文档</title><link rel="stylesheet" href="/swagger-ui/swagger-ui.css"></head><body style="margin:0"><div id="swagger-ui"></div><script src="/swagger-ui/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/swagger/json-schema",dom_id:"#swagger-ui",deepLinking:true})</script></body></html>'; });
  return router;
}

@Controller()
class CompatibilityController {
  constructor(@Inject('API_ROUTER') private readonly router: ApiRouter) {}
  @All('{*path}')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Pagination-Total-Count,X-Pagination-Page-Count,X-Pagination-Current-Page,X-Pagination-Per-Page' };
    res.set(corsHeaders);
    if (req.method === 'OPTIONS' && this.router.match('OPTIONS', req.path)) {
      res.set({ 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*', 'Access-Control-Max-Age': '86400' });
    }
    try {
      const match = this.router.match(req.method, req.path);
      if (!match) {
        const options = this.router.match('OPTIONS', req.path);
        if (options) {
          res.status(405);
          await options.route.handler({ req, res, body: req.body ?? {}, query: req.query, params: options.params });
          if (res.getHeader('Allow')) res.setHeader('Access-Control-Allow-Methods', String(res.getHeader('Allow')));
          res.json(null); return;
        }
        throw new ApiError(404, 'Page not found.');
      }
      const body = req.body ?? {};
      const result = await match.route.handler({ req, res, body, query: req.query, params: match.params });
      if (res.headersSent) return;
      if (req.method === 'HEAD' || res.statusCode === 204) { res.end(); return; }
      if (typeof result === 'string' && res.getHeader('Content-Type')) res.send(result);
      else res.json(result === undefined ? null : result);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const isAdminDatabaseError = (req.path.startsWith('/admin-api') || req.path.startsWith('/v2/web-login')) && !!(error as any)?.sqlState;
      const result = errorPayload(isAdminDatabaseError ? new ApiError(503, '服务暂时不可用，请稍后重试') : error);
      res.status(result.status).json(result.body);
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
  server.set('query parser', 'extended');
  server.use('/swagger-ui', express.static(dirname(require.resolve('swagger-ui-dist/swagger-ui-bundle.js'))));
  if (process.env.TRUST_PROXY) server.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : process.env.TRUST_PROXY);
  const verify = (req: Request, _res: Response, buffer: Buffer) => { (req as any).rawBody = buffer; };
  app.use(express.json({ limit: '2mb', verify, strict: false }));
  app.use(express.urlencoded({ extended: true, limit: '2mb', verify }));
  app.use((error: any, _req: Request, res: Response, next: express.NextFunction) => {
    if (error?.type === 'entity.parse.failed') res.status(400).json({ name: 'Bad Request', message: 'Invalid JSON data in request body.', code: 0, status: 400 });
    else if (error?.status === 413) res.status(413).json({ name: 'Payload Too Large', message: 'Request entity too large.', code: 0, status: 413 });
    else next(error);
  });
  await app.init();
  return app;
}
