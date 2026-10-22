import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Row, Services } from '../src/core/contracts';
import { ApiRouter } from '../src/core/router';
import { AdminDevices } from '../src/admin/devices';
import { registerAdmin } from '../src/admin';
import { AdminTokens } from '../src/admin/tokens';
import { AdminTokenStore } from '../src/admin/token-store';
import { sha256 } from '../src/admin/sessions';
import { V1Models } from '../src/v1/models';

class DeleteDatabase {
  readonly sqlite = new DatabaseSync(':memory:');
  readonly queries: string[] = [];
  constructor(nullable = true) {
    this.sqlite.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE player (id INTEGER PRIMARY KEY, tel TEXT NOT NULL);
      CREATE TABLE user (id INTEGER PRIMARY KEY);
      CREATE TABLE device (id INTEGER PRIMARY KEY, uuid TEXT);
      CREATE TABLE record (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL REFERENCES player(id), device_id INTEGER ${nullable ? '' : 'NOT NULL'} REFERENCES device(id) ON DELETE CASCADE, status TEXT, game JSON, startTime TEXT, endTime TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE setup (id INTEGER PRIMARY KEY, device_id INTEGER REFERENCES device(id) ON DELETE CASCADE, title TEXT);
      CREATE TABLE control (id INTEGER PRIMARY KEY, device_id INTEGER REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER);
      CREATE TABLE manager (id INTEGER PRIMARY KEY, device_id INTEGER REFERENCES device(id) ON DELETE CASCADE, player_id INTEGER);
      INSERT INTO player VALUES (1,'player');
      INSERT INTO user VALUES (7);
      INSERT INTO device VALUES (1,'removed'),(2,'retained');
      INSERT INTO record VALUES (11,1,1,'finish','{"points":15}', '2026-10-20 09:00:00', '2026-10-20 09:01:00','2026-10-20 08:59:00','2026-10-20 09:01:00'),(12,1,2,'ready','{"points":4}',null,null,'2026-10-21 09:00:00','2026-10-21 09:00:00');
      INSERT INTO setup VALUES (1,1,'removed setup'),(2,2,'retained setup');
      INSERT INTO control VALUES (1,1,7),(2,2,7);
      INSERT INTO manager VALUES (1,1,1),(2,2,1);
    `);
  }
  async query(sql: string, values: any[] = []): Promise<Row[]> {
    this.queries.push(sql);
    return this.sqlite.prepare(sql.replace(/ FOR UPDATE\b/g, '')).all(...values) as Row[];
  }
  async one(sql: string, values: any[] = []) { return (await this.query(sql, values))[0] ?? null; }
  async execute(sql: string, values: any[] = []) {
    this.queries.push(sql);
    const result = this.sqlite.prepare(sql).run(...values);
    return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) };
  }
  async columns(table: string) {
    return (await this.query(`PRAGMA table_info(\`${table}\`)`)).map(row => ({ name: row.name, type: row.type, nullable: !row.notnull, key: row.pk ? 'PRI' : '' }));
  }
  async update(table: string, id: any, values: Row) {
    const keys = Object.keys(values);
    await this.execute(`UPDATE \`${table}\` SET ${keys.map(key => '`'+key+'`=?').join(',')} WHERE id=?`, [...keys.map(key => typeof values[key] === 'object' && values[key] !== null ? JSON.stringify(values[key]) : values[key]), id]);
    return (await this.one(`SELECT * FROM \`${table}\` WHERE id=?`, [id]))!;
  }
  async insert(table: string, values: Row) {
    const keys = Object.keys(values);
    const saved = await this.execute(`INSERT INTO \`${table}\` (${keys.map(key => '`'+key+'`').join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(key => typeof values[key] === 'object' && values[key] !== null ? JSON.stringify(values[key]) : values[key]));
    return (await this.one(`SELECT * FROM \`${table}\` WHERE id=?`, [saved.insertId]))!;
  }
  async transaction<T>(operation: (db: DeleteDatabase) => Promise<T>): Promise<T> {
    this.sqlite.exec('BEGIN');
    try { const result = await operation(this); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  snapshot() { return Object.fromEntries(['device','record','setup','control','manager'].map(table => [table, this.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])); }
}

class TokenRedis {
  private rows = new Map<string, string>();
  async command([command, key, value]: string[]): Promise<any> {
    if (command === 'SET') { this.rows.set(key, value); return 'OK'; }
    if (command === 'GET') return this.rows.get(key) ?? null;
    throw new Error('Unexpected test Redis command');
  }
}
const keyDirectory = mkdtempSync(join(tmpdir(), 'wechat-device-delete-'));
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
writeFileSync(join(keyDirectory, 'private.pem'), keys.privateKey);
writeFileSync(join(keyDirectory, 'public.pem'), keys.publicKey);
afterAll(() => rmSync(keyDirectory, { recursive: true, force: true }));
beforeEach(() => {
  vi.stubEnv('ADMIN_USERNAME', 'delete-admin');
  vi.stubEnv('ADMIN_PASSWORD_HASH', 'same-configured-password-hash');
  vi.stubEnv('ADMIN_AUTH_ISSUER', 'https://admin.example');
  vi.stubEnv('ADMIN_JWT_KEY', join(keyDirectory, 'private.pem'));
  vi.stubEnv('ADMIN_JWT_PUB_KEY', join(keyDirectory, 'public.pem'));
});
afterEach(() => vi.unstubAllEnvs());
async function fixture(nullable = true, source: 'password' | 'wechat' = 'password') {
  const db = new DeleteDatabase(nullable), redis = new TokenRedis();
  const services = { db, redis } as unknown as Services;
  const tokens = new AdminTokens(new AdminTokenStore(redis));
  const pair = await tokens.issue(source === 'password' ? { source, username: 'delete-admin', credentialFingerprint: sha256('same-configured-password-hash') } : { source, username: 'wechat:7', wechatUserId: 7 });
  const router = new ApiRouter(); registerAdmin(router, services);
  const request = async (id: number, authorization: string | undefined = `Bearer ${pair.accessToken}`) => {
    const route = router.match('DELETE', `/admin-api/devices/${id}`);
    expect(route, 'the current game DELETE device route must be registered').not.toBeNull();
    return route!.route.handler({ body: {}, query: {}, params: route!.params, req: { headers: { authorization } }, res: { setHeader() {} } } as unknown as Context);
  };
  return { db, request, devices: new AdminDevices(services) };
}

describe('current game administrator device deletion', () => {
  it('allows only a password administrator and rejects anonymous or scan manager identities', async () => {
    const manager = await fixture(true, 'wechat'), original = manager.db.snapshot();
    await expect(manager.request(1)).rejects.toMatchObject({ status: 403, message: '仅管理员可以删除设备' });
    expect(manager.db.snapshot()).toEqual(original);
    const anonymous = await fixture();
    await expect(anonymous.request(1, '')).rejects.toMatchObject({ status: 401 });
  });
  it('locks the device and detaches history without changing any business or timestamp field', async () => {
    const f = await fixture(), original = f.db.snapshot();
    expect(await f.request(1)).toEqual({ id: 1, deleted: true });
    const after = f.db.snapshot();
    expect(after.record).toEqual((original.record as Row[]).map(row => row.device_id === 1 ? { ...row, device_id: null } : row));
    for (const table of ['device','setup','control','manager']) expect(after[table]).toEqual((original[table] as Row[]).filter(row => table === 'device' ? row.id !== 1 : row.device_id !== 1));
    expect(f.db.queries).toContain('SELECT * FROM device WHERE id=? FOR UPDATE');
  });
  it('refuses deletion before writes when the history migration has not made device_id nullable', async () => {
    const f = await fixture(false), original = f.db.snapshot();
    await expect(f.request(1)).rejects.toMatchObject({ status: 503, message: '设备暂时无法删除，请稍后重试' });
    expect(f.db.snapshot()).toEqual(original);
  });
  it('locks related records and rejects a ready or running game before detaching history', async () => {
    for (const status of ['ready','running']) {
      const f = await fixture();
      await f.db.execute('UPDATE record SET status=? WHERE id=11',[status]);
      const original = f.db.snapshot();
      await expect(f.request(1)).rejects.toMatchObject({ status: 409, message: '设备仍有未结束的游戏，请先结束游戏后再删除' });
      expect(f.db.snapshot()).toEqual(original);
      expect(f.db.queries).toContain('SELECT id,status FROM record WHERE device_id=? FOR UPDATE');
    }
  });
  it('returns 404 for a missing device and rolls back SQL failures after detaching history', async () => {
    const f = await fixture(), original = f.db.snapshot();
    await expect(f.request(99)).rejects.toMatchObject({ status: 404, message: '设备不存在' });
    f.db.sqlite.exec("CREATE TRIGGER reject_device_delete BEFORE DELETE ON device BEGIN SELECT RAISE(ABORT,'private storage failure'); END;");
    await expect(f.request(1)).rejects.toMatchObject({ status: 503, message: '设备暂时无法删除，请稍后重试' });
    expect(f.db.snapshot()).toEqual(original);
  });
});

describe('v1 detached historical record validation', () => {
  it('permits an existing detached record to be edited while retaining its null device reference', async () => {
    const f = await fixture();
    await f.db.execute('UPDATE record SET device_id=NULL WHERE id=11');
    const models = new V1Models(f.db as any), previous = (await models.find('record', 11))!;
    expect(await models.save('record', { status: 'finish' }, previous)).toMatchObject({ id: 11, device_id: null, player_id: 1 });
  });
  it('still requires a device for new records and records previously associated with a device', async () => {
    const f = await fixture(), models = new V1Models(f.db as any);
    await expect(models.save('record', { player_id: 1, device_id: null })).rejects.toMatchObject({ status: 422 });
    await expect(models.save('record', { device_id: null }, (await models.find('record', 11))!)).rejects.toMatchObject({ status: 422 });
    expect((await models.find('record', 11))!.device_id).toBe(1);
  });
});
