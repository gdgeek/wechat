import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import bcrypt from 'bcryptjs';
import type { INestApplication } from '@nestjs/common';
import { createApplication, createServices } from '../../src/application';
import { SceneCatalog } from '../../src/admin/scenes';
import { canonicalOrigin } from '../../src/admin/tickets';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Services } from '../../src/core/contracts';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real HTTP + MySQL-compatible database + Redis backend', () => {
  let app: INestApplication, s: Services, request: ReturnType<typeof supertest>;
  const origin = `https://game-http-${randomBytes(16).toString('hex')}.example`;
  let token: string;
  let keyDirectory: string;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'wechat_test') throw new Error('HTTP integration tests require the isolated localhost wechat_test database');
    if (!['127.0.0.1', 'localhost'].includes(process.env.REDIS_HOST || '') || !process.env.REDIS_PORT || process.env.REDIS_URL) throw new Error('HTTP integration tests require an explicitly selected localhost Redis test port without REDIS_URL');
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_AUTH_REDIS_HOST = process.env.REDIS_HOST;
    process.env.ADMIN_AUTH_REDIS_PORT = process.env.REDIS_PORT;
    process.env.ADMIN_AUTH_REDIS_DB = '15';
    process.env.ADMIN_AUTH_ISSUER = origin;
    keyDirectory = mkdtempSync(join(tmpdir(), 'wechat-jwt-http-'));
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    process.env.ADMIN_JWT_KEY = join(keyDirectory, 'private.pem');
    process.env.ADMIN_JWT_PUB_KEY = join(keyDirectory, 'public.pem');
    writeFileSync(process.env.ADMIN_JWT_KEY, keys.privateKey, { mode: 0o600 });
    writeFileSync(process.env.ADMIN_JWT_PUB_KEY, keys.publicKey);
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
  async function clearOwnAuthState() {
    if (!s?.adminAuthRedis) return;
    let cursor = '0';
    do {
      const page = await s.adminAuthRedis.command(['SCAN', cursor, 'MATCH', `game:admin:auth:issuer:${createHash('sha256').update(origin).digest('hex')}:*`, 'COUNT', '100']);
      cursor = page[0];
      if (page[1].length) await s.adminAuthRedis.command(['DEL', ...page[1]]);
    } while (cursor !== '0');
  }
  afterAll(async () => { try { await clearOwnAuthState(); } finally { await app?.close(); if (s) await Promise.allSettled([s.db.close(), s.redis.close(), s.adminAuthRedis?.close()]); if (keyDirectory) rmSync(keyDirectory, { recursive: true, force: true }); } });
  beforeEach(async () => {
    await clearOwnAuthState();
    for (const table of ['node_browser_session', 'node_rate_limit', 'admin_scan_login_ticket', 'record', 'manager', 'control', 'setup', 'device', 'player', 'user']) await s.db.execute(`DELETE FROM \`${table}\``);
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
    const owner = randomBytes(32).toString('hex');
    agent.set('X-Admin-Scan-Owner', owner);
    const session = await agent.get('/admin-api/session').expect(200);
    expect(session.body).toMatchObject({ user: null, authMode: 'jwt' });
    expect(session.headers['set-cookie']).toBeUndefined();
    return { agent, owner };
  }
  async function login() {
    const { agent, owner } = await browser();
    const result = await agent.post('/admin-api/login').send({ username: 'admin-test', password: 'local-test-password' }).expect(200);
    expect(result.body).toMatchObject({ authMode: 'jwt', token: { accessToken: expect.any(String), refreshToken: expect.any(String) } });
    agent.set('Authorization', `Bearer ${result.body.token.accessToken}`);
    return { agent, owner, tokens: result.body.token };
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
  it('matches the unchanged JWT frontend contract and rotates/revokes credentials across backend instances', async () => {
    const { agent } = await browser();
    await agent.get('/admin-api/devices').expect(401);
    const result = await agent.post('/admin-api/login').send({ username: 'admin-test', password: 'local-test-password' }).expect(200);
    expect(result.body).toMatchObject({ user: { username: 'admin-test', role: 'admin' }, authMode: 'jwt' });
    expect(result.body.csrfToken).toBeUndefined();
    expect(result.headers['set-cookie']).toBeUndefined();
    const pair = result.body.token;
    const other = createServices(), otherApp = await createApplication(other);
    try {
      const second = supertest(otherApp.getHttpServer());
      expect((await second.get('/admin-api/devices').set('Authorization', `Bearer ${pair.accessToken}`).expect(200)).body).toHaveLength(2);
      const refreshed = await second.post('/admin-api/refresh').send({ refreshToken: pair.refreshToken }).expect(200);
      expect(refreshed.body.token.refreshToken).not.toBe(pair.refreshToken);
      expect(refreshed.body.token.refreshExpires).toBe(pair.refreshExpires);
      await agent.post('/admin-api/refresh').send({ refreshToken: pair.refreshToken }).expect(401);
      await agent.post('/admin-api/logout').set('Authorization', `Bearer ${pair.accessToken}`).send({ refreshToken: refreshed.body.token.refreshToken }).expect(200);
      await second.get('/admin-api/devices').set('Authorization', `Bearer ${refreshed.body.token.accessToken}`).expect(401);
      await request.get('/v2/devices').set('Authorization', `Bearer ${refreshed.body.token.accessToken}`).expect(401);
      await request.get('/admin-api/devices').set('Authorization', `Bearer ${token}`).expect(401);
    } finally { await otherApp.close(); await Promise.allSettled([other.db.close(), other.redis.close(), other.adminAuthRedis?.close()]); }
  });
  it('keeps failure counters across rejected login transactions and uses the original 60 second window', async () => {
    const { agent } = await browser();
    for (let i = 0; i < 5; i++) await agent.post('/admin-api/login').send({ username: `bad-${i}`, password: 'incorrect' }).expect(401);
    const limited = await agent.post('/admin-api/login').send({ username: 'admin-test', password: 'local-test-password' }).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('preserves partial configuration fields and rejects objects supplied as arrays', async () => {
    const { agent } = await login();
    const result = await agent.put('/admin-api/devices/1/configuration').send({ title: ' New title ', pictures: [' a ', ''] }).expect(200);
    expect(result.body).toMatchObject({ title: 'New title', pictures: ['a'], slogans: ['keep'], gameId: 3 });
    await agent.put('/admin-api/devices/1/configuration').send({ slogans: {} }).expect(422);
    await agent.put('/admin-api/devices/1/configuration').send([]).expect(422);
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
  it('deletes a device and its current configuration while preserving detached game history', async () => {
    const player = await s.db.insert('player', { tel: 'device-history-player' });
    const record = await s.db.insert('record', { player_id: player.id, device_id: 1, status: 'finish', game: { preserved: true } });
    await s.db.insert('manager', { player_id: player.id, device_id: 1, type: 'staff' });
    const { agent } = await login();
    await request.delete('/admin-api/devices/1').expect(401);
    expect((await agent.delete('/admin-api/devices/1').expect(200)).body).toEqual({ id: 1, deleted: true });
    expect(await s.db.one('SELECT * FROM record WHERE id=?', [record.id])).toEqual({ ...record, device_id: null });
    for (const table of ['setup', 'control', 'manager']) expect(await s.db.one(`SELECT * FROM ${table} WHERE device_id=1`)).toBeNull();
    expect(await s.db.one('SELECT * FROM device WHERE id=1')).toBeNull();
    await agent.delete('/admin-api/devices/1').expect(404);
  });
  it('rolls back detached history and associated rows when device deletion fails', async () => {
    const player = await s.db.insert('player', { tel: 'rollback-history-player' });
    const record = await s.db.insert('record', { player_id: player.id, device_id: 1, status: 'finish', game: { preserved: true } });
    const { agent } = await login();
    const trigger = `test_delete_failure_${randomBytes(8).toString('hex')}`;
    await s.db.execute(`CREATE TRIGGER ${trigger} BEFORE DELETE ON device FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated test failure'`);
    try {
      const result = await agent.delete('/admin-api/devices/1').expect(503);
      expect(JSON.stringify(result.body)).not.toContain('isolated test failure');
      expect(await s.db.one('SELECT * FROM record WHERE id=?', [record.id])).toEqual(record);
      expect(await s.db.one('SELECT id FROM device WHERE id=1')).toEqual({ id: 1 });
      expect(await s.db.one('SELECT device_id FROM setup WHERE device_id=1')).toEqual({ device_id: 1 });
      expect(await s.db.one('SELECT device_id FROM control WHERE device_id=1')).toEqual({ device_id: 1 });
    } finally { await s.db.execute(`DROP TRIGGER ${trigger}`); }
  });
  it('rejects deleting a device with an unfinished game without changing its history', async () => {
    const player = await s.db.insert('player', { tel: 'active-history-player' });
    const record = await s.db.insert('record', { player_id: player.id, device_id: 1, status: 'ready' });
    const { agent } = await login();
    for (const status of ['ready', 'running']) {
      await s.db.execute('UPDATE record SET status=? WHERE id=?', [status, record.id]);
      await agent.delete('/admin-api/devices/1').expect(409);
      expect(await s.db.one('SELECT id,device_id,status FROM record WHERE id=?', [record.id])).toEqual({ id: record.id, device_id: 1, status });
      expect(await s.db.one('SELECT id FROM device WHERE id=1')).toEqual({ id: 1 });
    }
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
  it('returns Yii validation errors instead of SQL failures for malformed foreign keys', async () => {
    const player = await s.db.insert('player', { tel: 'validation-player' });
    const auth = `Bearer ${s.auth.issue(player, 'v1-player', origin).accessToken}`;
    const award = await request.post('/v1/award').set('Authorization', auth).send({ shop_id: [] }).expect(422);
    expect(award.body).toContainEqual(expect.objectContaining({ field: 'shop_id' }));
    const record = await request.post('/v1/record').set('Authorization', auth).send({ player_id: player.id, device_id: [] }).expect(422);
    expect(record.body).toContainEqual(expect.objectContaining({ field: 'device_id' }));
  });
  it('bridges a WeChat approval to an owner-bound single-use JWT login with live device scope', async () => {
    const { agent } = await browser();
    const ticket = (await agent.post('/admin-api/scan-login/tickets').expect(200)).body;
    const secret = new URL(ticket.qrText).searchParams.get('secret');
    const approval = await request.post(`/v2/web-login/tickets/${ticket.ticketId}/approve`).set('Authorization', `Bearer ${token}`).send({ secret }).expect(200);
    expect(approval.headers['cache-control']).toBe('no-store');
    expect(approval.body).toEqual({ success: true, message: '已确认管理后台登录', data: { status: 'approved' } });
    expect((await agent.get('/admin-api/session')).body.user).toBeNull();
    const other = await browser();
    await other.agent.get(`/admin-api/scan-login/tickets/${ticket.ticketId}`).expect(404);
    const consumed = await agent.post(`/admin-api/scan-login/tickets/${ticket.ticketId}/consume`).expect(200);
    expect(consumed.body.user).toEqual({ username: 'wechat:1', role: 'device_manager' });
    expect(consumed.body.authMode).toBe('jwt');
    agent.set('Authorization', `Bearer ${consumed.body.token.accessToken}`);
    await agent.delete('/admin-api/devices/1').expect(403);
    await agent.post(`/admin-api/scan-login/tickets/${ticket.ticketId}/consume`).expect(409);
    expect((await agent.get('/admin-api/devices')).body.map((row: any) => row.id)).toEqual([1]);
    await agent.put('/admin-api/devices/2/configuration').send({ title: 'forbidden' }).expect(404);
    await s.db.execute('DELETE FROM control WHERE user_id=1');
    expect((await agent.get('/admin-api/devices')).body).toEqual([]);
  });
  it('rejects expired/cancelled tickets and malformed secrets using the original response status', async () => {
    const { agent } = await browser();
    const ticket = (await agent.post('/admin-api/scan-login/tickets').expect(200)).body;
    await request.post(`/v2/web-login/tickets/${ticket.ticketId}/approve`).set('Authorization', `Bearer ${token}`).send({ secret: 'invalid' }).expect(422);
    await s.db.execute('UPDATE admin_scan_login_ticket SET expires_at=1 WHERE id=?', [ticket.ticketId]);
    expect((await agent.get(`/admin-api/scan-login/tickets/${ticket.ticketId}`).expect(200)).body.status).toBe('expired');
    await agent.post(`/admin-api/scan-login/tickets/${ticket.ticketId}/consume`).expect(410);
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
  it('preserves concurrent authenticated configuration writes without exhausting the pool', async () => {
    const { agent } = await login();
    const results = await Promise.all(Array.from({ length: 12 }, () => agent.put('/admin-api/devices/1/configuration').send({ title: 'Concurrent name' })));
    expect(results.map(response => response.status)).toEqual(Array(12).fill(200));
    expect(await s.db.one('SELECT title FROM setup WHERE device_id=1')).toEqual({ title: 'Concurrent name' });
  }, 15000);
});
