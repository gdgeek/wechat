import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import bcrypt from 'bcryptjs';
import type { INestApplication } from '@nestjs/common';
import { createApplication, createServices } from '../../src/application';
import { SceneCatalog } from '../../src/admin/scenes';
import { canonicalOrigin } from '../../src/admin/tickets';
import { createHash } from 'node:crypto';
import type { Services } from '../../src/core/contracts';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real HTTP + MySQL-compatible database + Redis backend', () => {
  let app: INestApplication, s: Services, request: ReturnType<typeof supertest>;
  const origin = 'https://game.test';
  let token: string;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'wechat_test') throw new Error('HTTP integration tests require the isolated localhost wechat_test database');
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('local-test-password', 4);
    process.env.ADMIN_USERNAME = 'admin-test';
    process.env.ADMIN_SCAN_LOGIN_ORIGIN = origin;
    process.env.JWT_SECRET = 'local-test-key-with-at-least-thirty-two-bytes';
    process.env.SWAGGER_USERNAME = 'docs-test';
    process.env.SWAGGER_PASSWORD = 'docs-password';
    s = createServices();
    s.catalog = new SceneCatalog({ fetch: async () => new Response(JSON.stringify([{ verse_id: 3, name: 'Test scene' }])) });
    app = await createApplication(s);
    await app.listen(0, '127.0.0.1');
    request = supertest(app.getHttpServer());
  });
  afterAll(async () => { await app?.close(); if (s) await Promise.allSettled([s.db.close(), s.redis.close()]); });
  beforeEach(async () => {
    for (const table of ['node_browser_session', 'node_rate_limit', 'admin_scan_login_ticket', 'control', 'setup', 'device', 'user']) await s.db.execute(`DELETE FROM \`${table}\``);
    await s.db.insert('user', { id: 1, unionid: 'local-test-owner', openid: 'owner-openid' });
    await s.db.insert('user', { id: 2, unionid: 'local-test-other', openid: 'other-openid' });
    await s.db.insert('device', { id: 1, uuid: 'owned-device', tag: 'owned', version: 1 });
    await s.db.insert('device', { id: 2, uuid: 'other-device', tag: 'other', version: 1 });
    await s.db.insert('control', { user_id: 1, device_id: 1 });
    await s.db.insert('setup', { device_id: 1, title: 'Owned device', scene_id: 3, slogans: ['keep'], pictures: [], thumbs: [] });
    token = s.auth.issue({ id: 1 }, 'v2-user', origin).accessToken;
  });
  async function browser() {
    const agent = supertest.agent(app.getHttpServer());
    const session = await agent.get('/admin-api/session').expect(200);
    return { agent, csrf: session.body.csrfToken as string };
  }
  async function login() {
    const { agent, csrf } = await browser();
    const result = await agent.post('/admin-api/login').set('X-CSRF-Token', csrf).send({ username: 'admin-test', password: 'local-test-password' }).expect(200);
    return { agent, csrf: result.body.csrfToken as string };
  }
  it('serves real health and HEAD, OpenAPI, pagination headers and correct missing routes', async () => {
    const health = await request.get('/health').expect(200);
    expect(health.body).toMatchObject({ status: 'healthy', checks: { database: { status: 'up' }, redis: { status: 'up' } } });
    expect((await request.head('/health').expect(200)).text).toBeUndefined();
    await request.get('/swagger/json-schema').expect(401);
    expect((await request.get('/swagger/json-schema').auth('docs-test', 'docs-password').expect(200)).body.openapi).toBe('3.0.3');
    const options = await request.options('/v2/devices').expect(200);
    expect(options.headers.allow).toBe('GET, POST, HEAD, OPTIONS');
    expect((await request.put('/v2/devices').expect(405)).body).toBeNull();
    await request.get('/v2/site/login').expect(404);
    await request.get('/v1/manager/login').expect(404);
    await request.get('/v2/player').expect(404);
    const owned = await request.get('/v2/devices?expand=setup').set('Authorization', `Bearer ${token}`).expect(200);
    expect(owned.headers['x-pagination-total-count']).toBe('1');
    expect(owned.body[0]).toMatchObject({ id: 1, setup: { title: 'Owned device' } });
    await request.get('/v2/devices/2').set('Authorization', `Bearer ${token}`).expect(404);
    await request.delete('/v2/files/1').set('Authorization', `Bearer ${token}`).expect(404);
    await request.get('/swagger').auth('docs-test', 'docs-password').expect(200);
    await request.get('/swagger-ui/swagger-ui-bundle.js').expect(200);
  });
  it('validates actual browser cookies and CSRF, rotates session and token on login/logout', async () => {
    const { agent, csrf } = await browser();
    await agent.get('/admin-api/devices').expect(401);
    await agent.post('/admin-api/login').send({ username: 'admin-test', password: 'local-test-password' }).expect(400);
    const result = await agent.post('/admin-api/login').set('X-CSRF-Token', csrf).send({ username: 'admin-test', password: 'local-test-password' }).expect(200);
    expect(result.body).toMatchObject({ user: { username: 'admin-test', role: 'admin' } });
    expect(result.body.csrfToken).not.toBe(csrf);
    expect(result.headers['set-cookie'][0]).toMatch(/HttpOnly;.*SameSite=Lax/);
    expect((await agent.get('/admin-api/devices').expect(200)).body).toHaveLength(2);
    await agent.post('/admin-api/logout').set('X-CSRF-Token', csrf).expect(400);
    const loggedOut = await agent.post('/admin-api/logout').set('X-CSRF-Token', result.body.csrfToken).expect(200);
    expect(loggedOut.body.user).toBeNull();
    await agent.get('/admin-api/devices').expect(401);
  });
  it('keeps failure counters across rejected login transactions and uses the original 60 second window', async () => {
    const { agent, csrf } = await browser();
    for (let i = 0; i < 5; i++) await agent.post('/admin-api/login').set('X-CSRF-Token', csrf).send({ username: `bad-${i}`, password: 'incorrect' }).expect(401);
    const limited = await agent.post('/admin-api/login').set('X-CSRF-Token', csrf).send({ username: 'admin-test', password: 'local-test-password' }).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('preserves partial configuration fields and rejects objects supplied as arrays', async () => {
    const { agent, csrf } = await login();
    const result = await agent.put('/admin-api/devices/1/configuration').set('X-CSRF-Token', csrf).send({ title: ' New title ', pictures: [' a ', ''] }).expect(200);
    expect(result.body).toMatchObject({ title: 'New title', pictures: ['a'], slogans: ['keep'], gameId: 3 });
    await agent.put('/admin-api/devices/1/configuration').set('X-CSRF-Token', csrf).send({ slogans: {} }).expect(422);
    await agent.put('/admin-api/devices/1/configuration').set('X-CSRF-Token', csrf).send([]).expect(422);
  });
  it('preserves JSON scalar types in Yii safe fields including strings that look like JSON', async () => {
    const setup = (await s.db.one('SELECT id FROM setup WHERE device_id=1'))!;
    const values = { slogans: '备注', pictures: '["picture"]', thumbs: '123', shots: false };
    const changed = await request.put(`/v2/setups/${setup.id}`).set('Authorization', `Bearer ${token}`).send(values).expect(200);
    expect(changed.body).toMatchObject(values);
    const read = await request.get(`/v2/setups/${setup.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(read.body).toMatchObject(values);
    const player = await s.db.insert('player', { tel: 'json-scalar-test', info: true });
    expect(player.info).toBe(true);
    await s.db.delete('player', player.id);
  });
  it('closes a game record whose safe JSON field holds a scalar without decoding it twice', async () => {
    await s.db.execute('DELETE FROM player WHERE tel=?', ['close-scalar-manager']);
    const player = await s.db.insert('player', { tel: 'close-scalar-manager', recharge: 100, cost: 10 });
    await s.db.insert('manager', { player_id: player.id, type: 'staff' });
    const shop = await s.db.insert('shop', { price: 10, rate: 80 });
    await s.db.update('device', 1, { shop_id: shop.id });
    await s.db.insert('operation', { shop_id: shop.id, pool: 8, income: 2, turnover: 10 });
    const record = await s.db.insert('record', { player_id: player.id, device_id: 1, game: '备注' });
    const playerToken = s.auth.issue(player, 'v1-player', origin).accessToken;
    try {
      const response = await request.post('/v1/system/close-record').set('Authorization', `Bearer ${playerToken}`).send({ recordId: record.id }).expect(200);
      expect(response.body.player.cost).toBe(0);
      expect(await s.db.one('SELECT * FROM record WHERE id=?', [record.id])).toBeNull();
    } finally { await s.db.delete('player', player.id); await s.db.delete('shop', shop.id); }
  });
  it('bridges a WeChat approval to an owner-bound single-use browser session with live device scope', async () => {
    const { agent, csrf } = await browser();
    const ticket = (await agent.post('/admin-api/scan-login/tickets').set('X-CSRF-Token', csrf).expect(200)).body;
    const secret = new URL(ticket.qrText).searchParams.get('secret');
    const approval = await request.post(`/v2/web-login/tickets/${ticket.ticketId}/approve`).set('Authorization', `Bearer ${token}`).send({ secret }).expect(200);
    expect(approval.headers['cache-control']).toBe('no-store');
    expect(approval.body).toEqual({ success: true, message: '已确认管理后台登录', data: { status: 'approved' } });
    expect((await agent.get('/admin-api/session')).body.user).toBeNull();
    const other = await browser();
    await other.agent.get(`/admin-api/scan-login/tickets/${ticket.ticketId}`).expect(404);
    const consumed = await agent.post(`/admin-api/scan-login/tickets/${ticket.ticketId}/consume`).set('X-CSRF-Token', csrf).expect(200);
    expect(consumed.body.user).toEqual({ username: 'wechat:1', role: 'device_manager' });
    const newCsrf = consumed.body.csrfToken;
    await agent.post(`/admin-api/scan-login/tickets/${ticket.ticketId}/consume`).set('X-CSRF-Token', newCsrf).expect(409);
    expect((await agent.get('/admin-api/devices')).body.map((row: any) => row.id)).toEqual([1]);
    await agent.put('/admin-api/devices/2/configuration').set('X-CSRF-Token', newCsrf).send({ title: 'forbidden' }).expect(404);
    await s.db.execute('DELETE FROM control WHERE user_id=1');
    expect((await agent.get('/admin-api/devices')).body).toEqual([]);
  });
  it('rejects expired/cancelled tickets and malformed secrets using the original response status', async () => {
    const { agent, csrf } = await browser();
    const ticket = (await agent.post('/admin-api/scan-login/tickets').set('X-CSRF-Token', csrf).expect(200)).body;
    await request.post(`/v2/web-login/tickets/${ticket.ticketId}/approve`).set('Authorization', `Bearer ${token}`).send({ secret: 'invalid' }).expect(422);
    await s.db.execute('UPDATE admin_scan_login_ticket SET expires_at=1 WHERE id=?', [ticket.ticketId]);
    expect((await agent.get(`/admin-api/scan-login/tickets/${ticket.ticketId}`).expect(200)).body.status).toBe('expired');
    await agent.post(`/admin-api/scan-login/tickets/${ticket.ticketId}/consume`).set('X-CSRF-Token', csrf).expect(410);
    expect(canonicalOrigin('https://game.test:443')).toBeNull();
  });
  it('stores legacy Redis hashes and list keys that Yii2 can read', async () => {
    const value = 'A' + 'b'.repeat(32);
    await s.redis.save('report', { token: value, status: 'ready', created_at: 1 });
    expect(await s.redis.find('report', value)).toMatchObject({ token: value, status: 'ready', created_at: '1' });
    expect(await s.redis.all('report')).toContainEqual(expect.objectContaining({ token: value }));
    await s.redis.remove('report', value);
    expect(await s.redis.find('report', value)).toBeNull();
  });
  it('shares diagnostic records across backend instances and masks credentials', async () => {
    const deviceToken = 'T' + 'a'.repeat(32), time = '1', uuid = 'shared-log-device';
    const hash = createHash('md5').update(`${deviceToken}${time}${uuid}buj1aban.c0m`).digest('hex');
    await request.post(`/v2/server/device?time=${time}&hash=${hash}`).set('Authorization', 'Bearer private-test-token').send({ token: deviceToken, uuid, status: 'ready' }).expect(200);
    const other = createServices();
    const otherApp = await createApplication(other);
    try {
      const result = await supertest(otherApp.getHttpServer()).get('/v1/helper/print').expect(200);
      expect(result.body).toMatchObject({ action: 'device', isGet: false, post: { uuid }, headers: { authorization: ['[redacted]'] } });
    } finally { await otherApp.close(); await Promise.allSettled([other.db.close(), other.redis.close()]); await s.redis.remove('report', deviceToken); }
  });
  it('shares session transaction connections under concurrent browser requests without exhausting the pool', async () => {
    const { agent, csrf } = await login();
    const results = await Promise.all(Array.from({ length: 12 }, () => agent.put('/admin-api/devices/1/configuration').set('X-CSRF-Token', csrf).send({ title: 'Concurrent name' })));
    expect(results.map(response => response.status)).toEqual(Array(12).fill(200));
    expect(await s.db.one('SELECT title FROM setup WHERE device_id=1')).toEqual({ title: 'Concurrent name' });
  }, 15000);
});
