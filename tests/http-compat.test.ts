import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import supertest from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/application';
import { AuthService } from '../src/core/auth';
import { ApiError, errorPayload } from '../src/core/errors';
import { Integrations } from '../src/integrations/integrations';
import type { Services } from '../src/core/contracts';

describe('Yii HTTP boundary compatibility', () => {
  let app: INestApplication, request: ReturnType<typeof supertest>;
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SWAGGER_USERNAME', 'test-docs');
    vi.stubEnv('SWAGGER_PASSWORD', 'test-password');
    const db = { query: vi.fn(async () => []), one: vi.fn(async () => null) };
    const services = { db, redis: { ping: async () => 'PONG', find: async () => null, save: async () => undefined }, auth: new AuthService(db as any), catalog: {}, integrations: new Integrations() } as unknown as Services;
    app = await createApplication(services);
    request = supertest(app.getHttpServer());
  });
  afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });

  it('serializes HTTP exceptions with the Yii public type without runtime details', async () => {
    const response = await request.get('/v2/devices').expect(401);
    expect(response.body).toEqual({ name: 'Unauthorized', message: 'Your request was made with invalid or expired JSON Web Token.', code: 0, status: 401, type: 'yii\\web\\UnauthorizedHttpException' });
    expect(response.headers.vary).toBe('Accept');
    expect(errorPayload(new Error('database password=private')).body).toEqual({ name: 'Internal Server Error', message: 'An internal server error occurred.', code: 0, status: 500, type: 'yii\\web\\HttpException' });
    const validation = new ApiError(422, 'Data Validation Failed.');
    validation.responseBody = [{ field: 'name', message: 'Name cannot be blank.' }];
    expect(errorPayload(validation).body).toEqual(validation.responseBody);
    expect(errorPayload(new ApiError(400, 'Legacy validation', undefined, 'HttpException')).body).toMatchObject({ type: 'yii\\web\\HttpException' });
    expect(errorPayload(new ApiError(422, 'Invalid input')).body).toMatchObject({ name: 'Unprocessable entity' });
  });

  it.each(['/unknown-route', '/v2/files/not-a-number', '/admin-api/no-route'])('renders unresolved %s as HTML even for JSON clients', async path => {
    const response = await request.get(path).set('Accept', 'application/json').expect(404);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.text).toContain('Not Found (#404)');
    expect(response.text).toContain('Page not found.');
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)('resolves disabled file CRUD %s as HTML before authentication', async method => {
    const response = await request[method](method === 'post' ? '/v2/files' : '/v2/files/1').expect(404);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
  });

  it('negotiates XML for successful scalar responses and exception arrays', async () => {
    const response = await request.get('/v2/devices').set('Accept', 'application/xml').expect(401);
    expect(response.headers['content-type']).toMatch(/^application\/xml/);
    expect(response.text).toContain('<response><name>Unauthorized</name>');
    expect(response.text).toContain('<type>yii\\web\\UnauthorizedHttpException</type>');
    const scalar = await request.get('/v2/server/test').set('Accept', 'application/xml').expect(200);
    expect(scalar.text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<response>2</response>\n');
  });

  it('respects Accept quality and the explicit _format query parameter', async () => {
    const response = await request.get('/v2/server/test').set('Accept', 'application/json;q=0.2, application/xml;q=0.8').expect(200);
    expect(response.headers['content-type']).toMatch(/^application\/xml/);
    const override = await request.get('/v2/server/test?_format=json').set('Accept', 'application/xml').expect(200);
    expect(override.body).toBe('2');
    const wildcard = await request.get('/v2/server/test').set('Accept', 'text/html,*/*;q=0.5').expect(200);
    expect(wildcard.body).toBe('2');
  });

  it('keeps the last repeated scalar query and form value without collapsing explicit arrays', async () => {
    const response = await request.get('/v2/server/test?_format=json&_format=xml').expect(200);
    expect(response.headers['content-type']).toMatch(/^application\/xml/);
    await request.get('/v2/server/test?_format[]=json&_format[]=xml').expect(400);
    const fingerprint = createHash('md5').update('geek.v0xe1.pa2ty.c0m1last').digest('hex');
    const signed = await request.post('/v1/common/sign-in').type('form').send(`openId=first&openId=last&timestamp=1&fingerprint=${fingerprint}`).expect(200);
    expect(signed.body).toEqual({ success: false, player: null, message: 'no signup' });
  });

  it('preserves XML empty scalar elements and SDK object names', async () => {
    const nulls = await request.get('/v2/server/log?token=').set('Accept', 'application/xml').expect(200);
    expect(nulls.text).toContain('<data><checkin></checkin><report></report><file></file></data>');
    const sdk = await request.get('/v1/we-chat/info').set('Accept', 'application/xml').expect(200);
    expect(sdk.text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<response><Application/></response>\n');
  });

  it('rejects unsupported Accept before authenticating with a JSON 406 response', async () => {
    const response = await request.get('/v2/devices').set('Accept', 'text/html').expect(406);
    expect(response.body).toEqual({ name: 'Not Acceptable', message: 'None of your requested content types is supported.', code: 0, status: 406, type: 'yii\\web\\NotAcceptableHttpException' });
  });

  it.each([['_format=csv', 406], ['_format[]=json', 400]] as const)('keeps pre-negotiation errors for %s in HTML', async (query, status) => {
    const response = await request.get(`/v2/server/test?${query}`).expect(status);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
  });

  it('keeps admin responses JSON independently of Accept', async () => {
    const response = await request.get('/admin-api/devices').set('Accept', 'text/html').expect(401);
    expect(response.body.message).toBe('请先登录管理后台');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('uses the resolved route for response negotiation after Yii path decoding', async () => {
    const health = await request.get('/%68ealth').expect(200);
    expect(health.body.status).toBe('healthy');
    const devices = await request.get('/%76%32/devices').expect(401);
    expect(devices.body.status).toBe(401);
    expect(devices.headers.vary).toBe('Accept');
    const admin = await request.get('/%61dmin-api/devices').expect(401);
    expect(admin.body.message).toBe('请先登录管理后台');
  });

  it('defers malformed JSON until an action actually reads the body', async () => {
    const malformed = '{"bad":';
    await request.post('/unknown-route').set('Content-Type', 'application/json').send(malformed).expect(404);
    await request.post('/v2/devices').set('Content-Type', 'application/json').send(malformed).expect(401);
    await request.get('/health').set('Content-Type', 'application/json').send(malformed).expect(200);
    const response = await request.post('/admin-api/login').set('Content-Type', 'application/json').send(malformed).expect(400);
    expect(response.body).toMatchObject({ type: 'yii\\web\\BadRequestHttpException', message: 'Invalid JSON data in request body: Syntax error' });
  });

  it('supports Yii method overrides without downgrading form POST to GET', async () => {
    expect((await request.post('/v2/server/test').set('X-Http-Method-Override', 'GET').expect(200)).body).toBe('2');
    const overridden = await request.post('/v2/devices/1').type('form').send({ _method: 'DELETE' }).expect(401);
    expect(overridden.body.type).toBe('yii\\web\\UnauthorizedHttpException');
    await request.post('/v2/server/test').type('form').send({ _method: 'GET' }).expect(404);
  });

  it('does not implicitly treat HEAD or other verbs as GET custom routes', async () => {
    await request.head('/v2/server/test').expect(404);
    await request.post('/health').expect(404);
    const response = await request.put('/v2/devices').expect(405);
    expect(response.body).toBeNull();
    expect(response.headers.allow).toBe('GET, POST, HEAD, OPTIONS');
    const head = await request.head('/health').expect(200);
    expect(head.headers['content-type']).toMatch(/^application\/json/);
    expect(head.text).toBeUndefined();
  });

  it('returns application CORS preflight before content negotiation and authentication', async () => {
    const response = await request.options('/v2/devices').set('Origin', 'https://example.com').set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'authorization,x-admin-scan-owner').set('Accept', 'text/html').expect(200);
    expect(response.text).toBe('');
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-headers']).toBe('Authorization, X-Admin-Scan-Owner');
    expect(response.headers['access-control-allow-methods']).toBe('GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
    expect(response.headers.allow).toBeUndefined();
    expect((await request.get('/health')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('uses the Swagger plain HTML authentication challenge before JSON schema generation', async () => {
    const response = await request.get('/swagger/json-schema').expect(401);
    expect(response.headers['www-authenticate']).toBe('Basic realm="Swagger API Documentation"');
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.text).toBe('需要认证才能访问 API 文档');
  });
});
