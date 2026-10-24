import type { Context, Row, Services } from '../core/contracts';
import { ApiError } from '../core/errors';
import { csv, hydrate, sqlNow } from './resources';
import { recordRequest } from '../core/diagnostics';
import { priceInCents } from './file-service';

const pictureBase = 'https://game-1251022382.cos.ap-nanjing.myqcloud.com/picture/';
export function defaultData(): Row {
  return { money: 0, slogans: ['我在这里很想你', '今天也要加油鸭', '阳光正好，微风不燥', '记录每一刻，热爱每一天'], thumbs: [1, 2, 3, 4].map(i => `${pictureBase}t${i}.webp`), shots: [1, 5, 10, 20] };
}
export async function defaultInfo(s: Services): Promise<Row> {
  const games = await s.catalog.getGames();
  return { title: '未知', pictures: [1, 2, 3, 4].map(i => `${pictureBase}t${i}.png`), scene_id: games[0]?.id ?? null, updated_at: sqlNow() };
}
function setupInfo(row: Row): Row { const value = hydrate(row); return Object.fromEntries(['title', 'pictures', 'scene_id', 'updated_at'].map(key => [key, value[key] ?? null])); }
function setupData(row: Row): Row { const value = hydrate(row); return Object.fromEntries(['money', 'slogans', 'thumbs', 'shots'].map(key => [key, value[key] ?? null])); }
export async function getInfo(s: Services, uuid: unknown, version: number | null = null): Promise<Row> {
  if (uuid !== null && uuid !== undefined && typeof uuid !== 'string') throw new ApiError(400, 'uuid must be a string');
  if (truthy(uuid)) {
    let device = await s.db.one('SELECT * FROM device WHERE uuid = ?', [uuid]);
    if (!device) {
      // Resolve the upstream directory before inserting anything, then commit the
      // device and its configuration together. A failed setup can never orphan it.
      const info = await defaultInfo(s);
      try {
        device = await s.db.transaction(async db => {
          const existing = await db.one('SELECT * FROM device WHERE uuid = ?', [uuid]);
          if (existing) return existing;
          const created = await db.insert('device', { uuid, version: 1, created_at: sqlNow(), updated_at: sqlNow() });
          await db.insert('setup', { device_id: created.id, ...defaultData(), ...info });
          return created;
        });
      } catch (error: any) {
        if (error?.code !== 'ER_DUP_ENTRY') throw error;
        device = await s.db.one('SELECT * FROM device WHERE uuid = ?', [uuid]);
        if (!device) throw error;
      }
    }
    if (version !== null && Number(device.version) !== version) {
      await s.db.execute('UPDATE device SET version = ? WHERE id = ?', [version, device.id]);
    }
    const setup = await s.db.one('SELECT * FROM setup WHERE device_id = ?', [device.id]);
    if (setup) return setupInfo(setup);
  }
  return defaultInfo(s);
}
const attributes: Record<string, string[]> = {
  report: ['token', 'uuid', 'device_id', 'status', 'data', 'created_at', 'updated_at'],
  applet: ['token', 'user_id', 'id', 'status', 'data', 'created_at', 'updated_at'],
  recode_file: ['token', 'key', 'created_at', 'updated_at', 'file_id'],
};
function redisRow(model: string, row: Row | null): Row | null {
  if (!row) return null;
  return Object.fromEntries(attributes[model].map(key => [key, row[key] ?? null]));
}
function truthy(value: any): boolean { return value !== null && value !== undefined && value !== false && value !== 0 && value !== '' && value !== '0' && !(typeof value === 'object' && Object.keys(value).length === 0); }
function requiredScalar(value: any, name: string): string {
  if (!truthy(value)) throw new ApiError(400, `${name} is required`, undefined, 'HttpException');
  if (typeof value !== 'string' && typeof value !== 'number') throw new ApiError(400, `${name} must be a string`);
  return String(value);
}
export function reportedVersion(body: Row): number {
  const value = Object.hasOwn(body, 'version') ? body.version : 0;
  const match = typeof value === 'string' ? /^[\t\n\v\r ]*([+-]?(?:0|[1-9][0-9]*))[\t\n\v\r ]*$/.exec(value) : null;
  const version = typeof value === 'number' ? value : match ? Number(match[1]) : NaN;
  if (!Number.isInteger(version) || version < 0 || version > 2147483647) throw new ApiError(400, 'version must be an integer between 0 and 2147483647');
  return version === 0 ? 0 : version;
}
async function getReport(s: Services, ctx: Context, token: string, uuid?: string, version = 0): Promise<Row | null> {
  let row = await s.redis.find('report', token);
  if (!uuid) return redisRow('report', row);
  row ||= { token, uuid, created_at: String(Math.floor(Date.now() / 1000)) };
  if (!row.device_id) {
    let device = await s.db.one('SELECT * FROM device WHERE uuid = ?', [row.uuid]);
    if (!device) device = await s.db.insert('device', { uuid, version: 1, ip: ctx.req.ip, created_at: sqlNow(), updated_at: sqlNow() });
    row.device_id = device.id;
  }
  // Yii updateAll() synchronizes every UUID login without firing timestamp behavior.
  await s.db.execute('UPDATE device SET version = ? WHERE id = ?', [version, row.device_id]);
  for (const key of ['status', 'data']) if (truthy(ctx.body[key])) row[key] = ctx.body[key];
  row.updated_at = String(Math.floor(Date.now() / 1000));
  await s.redis.save('report', row);
  return redisRow('report', row);
}
async function getApplet(s: Services, ctx: Context, token: string, id?: string, authenticatedUser?: Row): Promise<Row | null> {
  let row = await s.redis.find('applet', token);
  if (!id) return redisRow('applet', row);
  if (!row) {
    const user = authenticatedUser || await s.auth.bearer(ctx, 'v2-user');
    row = { token, id, user_id: user.id, created_at: String(Math.floor(Date.now() / 1000)) };
  }
  for (const key of ['status', 'data']) if (truthy(ctx.body[key])) row[key] = ctx.body[key];
  row.updated_at = String(Math.floor(Date.now() / 1000));
  await s.redis.save('applet', row);
  return redisRow('applet', row);
}
async function getFile(s: Services, token: string, key: string | undefined, applet: Row | null): Promise<Row | null> {
  let recorded = await s.redis.find('recode_file', token);
  if (!key) return redisRow('recode_file', recorded);
  if (!recorded && applet) {
    let file = await s.db.one('SELECT * FROM file WHERE `key` = ?', [key]);
    if (!file) {
      const report = await s.redis.find('report', token);
      const setup = report && truthy(report.device_id) ? await s.db.one('SELECT * FROM setup WHERE device_id = ?', [report.device_id]) : null;
      const price = priceInCents(setup ? setup.money : defaultData().money);
      const metadata = await s.integrations.fileMetadata(key);
      file = await s.db.insert('file', { ...metadata, key, unionid: applet.id, user_id: applet.user_id, price });
    } else file = await s.db.update('file', file.id, { user_id: applet.user_id });
    recorded = { token, key, created_at: file.created_at, updated_at: String(Math.floor(Date.now() / 1000)), file_id: file.id };
  }
  if (recorded) await s.redis.save('recode_file', recorded);
  return redisRow('recode_file', recorded);
}
export async function refresh(s: Services, ctx: Context, authenticatedUser?: Row): Promise<Row> {
  const token = requiredScalar(ctx.body.token, 'token');
  const values = ['uuid', 'id', 'key'].filter(key => truthy(ctx.body[key]));
  if (values.length !== 1) throw new ApiError(400, 'Exactly one of uuid, id, or key must be provided', undefined, 'HttpException');
  const kind = values[0], value = requiredScalar(ctx.body[kind], kind);
  await s.auth.requireDevice(ctx);
  const version = kind === 'uuid' ? reportedVersion(ctx.body) : 0;
  await recordRequest(s, ctx, ctx.req.path?.split('/').pop() || 'refresh');
  const expands = new Set(csv(ctx.query.expand));
  const report = await getReport(s, ctx, token, kind === 'uuid' ? value : undefined, version);
  const applet = await getApplet(s, ctx, token, kind === 'id' ? value : undefined, authenticatedUser);
  const file = await getFile(s, token, kind === 'key' ? value : undefined, applet);
  const data: Row = {};
  if (expands.has('token')) data.token = token;
  if (expands.has('setup')) {
    const device = report?.uuid ? await s.db.one('SELECT * FROM device WHERE uuid = ?', [report.uuid]) : null;
    const setup = device ? await s.db.one('SELECT * FROM setup WHERE device_id = ?', [device.id]) : null;
    data.setup = setup ? setupData(setup) : defaultData();
  }
  if (expands.has('info')) data.info = await getInfo(s, report?.uuid);
  if (expands.has('file')) data.file = file ? Object.fromEntries(Object.entries(file).filter(([key]) => !['token', 'updated_at'].includes(key))) : null;
  if (expands.has('applet')) data.applet = applet || [];
  if (expands.has('device')) data.device = report ? Object.fromEntries(Object.entries(report).filter(([key]) => !['setup', 'token', 'created_at', 'updated_at'].includes(key))) : [];
  return { data: Object.keys(data).length ? data : [], success: truthy(ctx.query.expand), message: truthy(ctx.query.expand) ? 'success' : 'need expand' };
}
export async function log(s: Services, token: any): Promise<Row> {
  if (token === undefined || token === null) throw new ApiError(400, 'Missing required parameters: token');
  token = String(token);
  const [checkin, report, file] = await Promise.all([s.redis.find('applet', token), s.redis.find('report', token), s.redis.find('recode_file', token)]);
  return { success: true, message: 'success', data: { checkin: redisRow('applet', checkin), report: redisRow('report', report), file: redisRow('recode_file', file) } };
}
