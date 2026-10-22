import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApplication, createServices } from '../../src/application';
import type { Services } from '../../src/core/contracts';

const oracle = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/yii-anonymous-http.json'), 'utf8'));
const cases = oracle.groups.flatMap((group: any) => group.cases.map((row: any) => ({ ...row, expected: group.expected })));

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('executed Yii anonymous HTTP response oracle', () => {
  let app: INestApplication, services: Services;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'wechat_test') throw new Error('Yii HTTP oracle requires isolated localhost wechat_test');
    vi.stubEnv('ADMIN_AUTH_ISSUER', 'https://isolated.example');
    vi.stubEnv('ADMIN_SCAN_LOGIN_ORIGIN', 'https://isolated.example');
    services = createServices();
    app = await createApplication(services);
  });
  afterAll(async () => {
    await app?.close();
    if (services) await Promise.allSettled([services.db.close(), services.redis.close(), services.adminAuthRedis?.close()]);
    vi.unstubAllEnvs();
  });
  it('ties the independent PHP response fixture to the accepted source configuration', () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../docs/source-manifest.json'), 'utf8'));
    expect(oracle.sourceHead).toBe(manifest.gitHead);
    expect(oracle.urlConfigSha256).toBe(manifest.files['files/api/config/web.php']);
    expect(cases).toHaveLength(oracle.count);
  });
  it.each(cases)('$method $path matches the executed Yii response', async ({ method, path, expected }: any) => {
    let request = (supertest(app.getHttpServer()) as any)[method.toLowerCase()](path).set('Origin', 'https://isolated.example');
    if (['POST', 'PUT', 'PATCH'].includes(method)) request = request.send({});
    const response = await request;
    const mime = (response.headers['content-type'] || '').split(';')[0];
    const body = method === 'HEAD' || !response.text ? null : mime === 'text/html'
      ? { htmlTitle: /<title>(.*?)<\/title>/s.exec(response.text)?.[1] }
      : response.body;
    expect({ status: response.status, mime, body, allow: response.headers.allow ?? null, auth: response.headers['www-authenticate'] ?? null }).toEqual(expected);
  });
});
