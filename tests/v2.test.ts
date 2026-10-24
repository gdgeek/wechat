import { describe, expect, it, vi } from 'vitest';
import type { Context, Row, Services } from '../src/core/contracts';
import { createHash } from 'node:crypto';
import { AuthService } from '../src/core/auth';

type Handler = (ctx: Context) => Promise<any> | any;
function mysqlLike(value:unknown, pattern:unknown):boolean {
  const text=String(pattern);let regex='^';
  const literal=(char:string)=>char.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  for(let i=0;i<text.length;i++) {
    if(text[i]==='\\'&&i+1<text.length) regex+=literal(text[++i]);
    else regex+=text[i]==='%' ? '.*' : text[i]==='_' ? '.' : literal(text[i]);
  }
  return new RegExp(regex+'$','s').test(String(value??''));
}
class MemoryDb {
  tables: Record<string, Row[]>;
  constructor(seed: Record<string, Row[]> = {}) { this.tables = structuredClone({ device: [], setup: [], control: [], file: [], user: [], ...seed }); }
  async query(sql: string, params: any[] = []): Promise<Row[]> {
    const table = sql.match(/FROM\s+`?(\w+)`?/i)?.[1];
    if (!table) throw new Error(`Unsupported SQL ${sql}`);
    let result = structuredClone(this.tables[table] || []);
    let offset = 0;
    if (/IN\s*\(SELECT device_id FROM `?control`? WHERE user_id = \?\)/i.test(sql)) {
      const uid = params[offset++];
      const allowed = this.tables.control.filter(c => String(c.user_id) === String(uid)).map(c => String(c.device_id));
      const key = table === 'setup' ? 'device_id' : 'id';
      result = result.filter(r => allowed.includes(String(r[key])));
    }
    const simple = sql.replace(/\w+(?:\.\w+)? IN\s*\(SELECT device_id FROM `?control`? WHERE user_id = \?\)/ig, '1=1');
    const where = simple.split(/\bWHERE\b/i)[1]?.split(/\bORDER BY\b|\bLIMIT\b/i)[0] || '';
    for (const match of where.matchAll(/(?:`?\w+`?\.)?`?(\w+)`?\s*(=|LIKE|!=)\s*\?/ig)) {
      const [, key, op] = match;
      const value = params[offset++];
      result = result.filter(r => op.toUpperCase() === 'LIKE' ? mysqlLike(r[key],value) : op === '!=' ? String(r[key]) !== String(value) : String(r[key]) === String(value));
    }
    if (/COUNT\(\*\)/i.test(sql)) return [{ total: result.length }];
    const order = sql.match(/ORDER BY\s+`?(\w+)`?\s*(ASC|DESC)?/i);
    if (order) result.sort((a, b) => (a[order[1]] > b[order[1]] ? 1 : a[order[1]] < b[order[1]] ? -1 : 0) * (order[2]?.toUpperCase() === 'DESC' ? -1 : 1));
    const limit = sql.match(/LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?/i);
    if (limit) result = result.slice(Number(limit[2] || 0), Number(limit[2] || 0) + Number(limit[1]));
    return result;
  }
  async one(sql: string, params: any[] = []) { return (await this.query(sql, params))[0] || null; }
  async insert(table: string, data: Row) { const row = { ...(table === 'setup' ? { money: 0 } : {}), id: Math.max(0, ...this.tables[table].map(r => Number(r.id))) + 1, ...structuredClone(data) }; this.tables[table].push(row); return structuredClone(row); }
  async update(table: string, id: any, data: Row) { const row = this.tables[table].find(r => String(r.id) === String(id)); if (!row) throw new Error('Row missing'); Object.assign(row, structuredClone(data)); return structuredClone(row); }
  async execute(sql: string, params: any[] = []) {
    if (/^UPDATE user SET role = \? WHERE id = \?$/i.test(sql)) {
      const row=this.tables.user.find(r=>String(r.id)===String(params[1]));
      if(row) row.role=params[0];
      return {affectedRows:row ? 1 : 0,insertId:0};
    }
    if (!/^UPDATE device SET version = \? WHERE id = \?$/i.test(sql)) throw new Error(`Unsupported SQL ${sql}`);
    const row = this.tables.device.find(r => String(r.id) === String(params[1]));
    if (row) row.version = params[0];
    return { affectedRows: row ? 1 : 0, insertId: 0 };
  }
  async delete(table: string, id: any) { this.tables[table] = this.tables[table].filter(r => String(r.id) !== String(id)); }
  async transaction<T>(fn: (db: MemoryDb) => Promise<T>) { const original = structuredClone(this.tables); try { return await fn(this); } catch (error) { this.tables = original; throw error; } }
  async columns(table: string) { return [...new Set(this.tables[table].flatMap(Object.keys))].map(name => ({ name })); }
}
class MemoryRedis {
  records: Record<string, Record<string, Row>> = {};
  async find(model: string, pk: string) { return structuredClone(this.records[model]?.[pk] || null); }
  async all(model: string) { return Object.values(structuredClone(this.records[model] || {})); }
  async save(model: string, row: Row) { (this.records[model] ||= {})[row.token] = structuredClone(row); return row; }
  async remove(model: string, pk: string) { delete this.records[model]?.[pk]; }
}
async function fixture(seed: Record<string, Row[]> = {}, user: Row | null = { id: 1, role: 'root' }) {
  const imported: any = await import('../src/v2/index').catch(() => ({}));
  expect(imported.registerV2, 'v2 contract routes must be implemented').toBeTypeOf('function');
  const routes = new Map<string, Handler>();
  const router = { add(methods: string | string[], path: string, handler: Handler) { for (const method of typeof methods === 'string' ? [methods] : methods) routes.set(`${method.toUpperCase()} ${path}`, handler); } };
  const db = new MemoryDb(seed), redis = new MemoryRedis();
  const services: any = { db, redis, auth: { bearer: vi.fn(async () => { if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 }); return user; }), requireDevice: vi.fn() }, catalog: { getGames: vi.fn(async () => [{ id: 42, name: 'Y1' }]), fetchScenes: vi.fn(async () => [{ verse_id: 42, name: 'Y1' }]), forwardCheckin: vi.fn(async () => [{ verse_id: 42, name: 'Y1' }]) }, integrations: { fileMetadata: vi.fn(async () => ({ key: 'movie.mp4', type: 'video/mp4', size: 256, md5: 'abc', bucket: 'bucket', created_at: '2026-10-22 10:00:00' })) } };
  imported.registerV2(router, services as Services);
  async function request(method: string, path: string, body: Row = {}, query: Row = {}, requestHeaders: Row = {}) {
    const match = [...routes.entries()].find(([key]) => {
      const [m, p] = key.split(' '); return m === method && new RegExp(`^${p.replace(/:[^/]+/g, '[^/]+')}$`).test(path);
    });
    expect(match, `${method} ${path} route must exist`).toBeTruthy();
    const params: Record<string, string> = {};
    match![0].split(' ')[1].split('/').forEach((part, i) => { if (part.startsWith(':')) params[part.slice(1)] = path.split('/')[i]; });
    const headers: Record<string, any> = {};
    const res: any = { statusCode: 200, setHeader: (name: string, value: any) => { headers[name.toLowerCase()] = value; }, header: (name: string, value: any) => { headers[name.toLowerCase()] = value; }, status(code: number) { this.statusCode = code; return this; } };
    const ctx: any = { body, query, params, req: { method, ip: '127.0.0.1', protocol: 'http', originalUrl: path, get: () => 'localhost', headers: requestHeaders }, res };
    const value = await match![1](ctx); return { value, headers, status: res.statusCode };
  }
  return { db, redis, services, request, routes };
}
const devices = [{ id: 1, uuid: 'mine', tag: 'mine', ip: null }, { id: 2, uuid: 'other', tag: 'other', ip: null }];
const controls = [{ id: 1, device_id: 1, user_id: 1 }];

describe('v2 device and setup contracts', () => {
  it('treats percent underscore and backslash in device search as literal characters',async()=>{
    const rows=['unit_1','unitx1','unit%1','unit\\1'].map((uuid,index)=>({id:index+1,uuid}));
    const f=await fixture({device:rows,control:rows.map(row=>({device_id:row.id,user_id:1}))});
    for(const [uuid,id] of [['_',1],['%',3],['\\',4]] as const) {
      const response=await f.request('GET','/v2/devices/manage',{}, {DeviceSearch:{uuid}});
      expect(response.value.map((row:Row)=>row.id)).toEqual([id]);
    }
  });
  it('persists optional empty numeric strings as null without changing their immediate response values',async()=>{
    const f=await fixture({device:devices,control:controls,setup:[{id:7,device_id:1,money:250,scene_id:1}]});
    expect((await f.request('PATCH','/v2/setups/7',{money:'',scene_id:''})).value).toMatchObject({money:'',scene_id:''});
    expect(f.db.tables.setup[0]).toMatchObject({money:null,scene_id:null});
  });
  it('refreshes expanded user roles without changing their persisted updated_at',async()=>{
    const original='2000-01-01 00:00:00';
    const f=await fixture({device:devices,control:controls,user:[{id:1,tel:'123',role:'user',updated_at:original}]});
    const update=f.db.update.bind(f.db);
    f.db.update=(table,id,data)=>update(table,id,table==='user' ? {updated_at:'changed-by-database-update',...data} : data);
    expect((await f.request('GET','/v2/devices/1',{}, {expand:'admin'})).value.admin[0].role).toBe('manager');
    expect(f.db.tables.user[0]).toMatchObject({role:'manager',updated_at:original});
  });
  it('serializes newly assigned setup attributes and raw numeric strings as Yii does after save',async()=>{
    const f=await fixture({device:devices,control:controls});
    const timestamp={expression:'NOW()',params:[]};
    expect((await f.request('POST','/v2/setups',{device_id:'1',money:'250'})).value).toEqual({id:1,device_id:'1',money:'250',updated_at:timestamp});
    expect((await f.request('PATCH','/v2/setups/1',{money:'300'})).value).toMatchObject({money:'300',updated_at:timestamp});
  });
  it('returns Yii field labels, specific string errors, and validator ordering',async()=>{
    const f=await fixture({device:devices,control:controls,setup:[{id:7,device_id:1,money:250}]});
    await expect(f.request('PATCH','/v2/devices/1',{uuid:true,tag:'a'.repeat(256)})).rejects.toMatchObject({status:422,responseBody:[
      {field:'uuid',message:'Uuid must be a string.'},{field:'tag',message:'Tag should contain at most 255 characters.'}
    ]});
    await expect(f.request('PATCH','/v2/devices/1',{uuid:'other'})).rejects.toMatchObject({status:422,responseBody:[{field:'uuid',message:'Uuid "other" has already been taken.'}]});
    await expect(f.request('PATCH','/v2/setups/7',{scene_id:'1.2',money:'0x10',title:false})).rejects.toMatchObject({status:422,responseBody:[
      {field:'scene_id',message:'Scene ID must be an integer.'},{field:'money',message:'Money must be a number.'},{field:'title',message:'Title must be a string.'}
    ]});
  });
  it('uses Yii numeric syntax for setup money and skips optional empty arrays',async()=>{
    const f=await fixture({device:devices,control:controls,setup:[{id:7,device_id:1,money:250,scene_id:1}]});
    for(const money of ['0x10',' ','1.',' 1',true,false,[1],{}]) {
      await expect(f.request('PATCH','/v2/setups/7',{money})).rejects.toMatchObject({status:422});
      expect(f.db.tables.setup[0].money).toBe(250);
    }
    expect((await f.request('PATCH','/v2/setups/7',{money:[],scene_id:[]})).value).toMatchObject({money:[],scene_id:[]});
    expect(f.db.tables.setup[0]).toMatchObject({money:0,scene_id:0});
  });
  it('ignores pageSize and unsafe version filters in the legacy device search model',async()=>{
    const f=await fixture({device:devices,control:[...controls,{device_id:2,user_id:1}]});
    const response=await f.request('GET','/v2/devices/manage',{}, {pageSize:1,DeviceSearch:{version:999}});
    expect(response.value.map((row:Row)=>row.id)).toEqual([1,2]);
    expect(response.headers['x-pagination-per-page']).toBe(20);
  });
  it('returns the scoped unfiltered list when DeviceSearch id validation fails',async()=>{
    const f=await fixture({device:devices,control:[...controls,{device_id:2,user_id:1}]});
    for(const id of ['invalid','1.5',true,[1]]) {
      const response=await f.request('GET','/v2/devices/manage',{}, {DeviceSearch:{id,uuid:'no-match'}});
      expect(response.value.map((row:Row)=>row.id)).toEqual([1,2]);
    }
  });
  it('scopes even root WeChat identities to control rows and supplies Yii pagination headers', async () => {
    const f = await fixture({ device: devices, control: controls });
    const r = await f.request('GET', '/v2/devices', {}, { 'per-page': 1, page: 1 });
    expect(r.value.map((d: Row) => d.id)).toEqual([1]);
    expect(String(r.headers['x-pagination-total-count'])).toBe('1');
    expect(String(r.headers['x-pagination-per-page'])).toBe('1');
    await expect(f.request('GET', '/v2/devices/2')).rejects.toMatchObject({ status: 404 });
  });
  it('requires a strict Bearer identity for scoped devices and blocks all WeChat administration', async () => {
    const f = await fixture({ device: devices, control: controls });
    for (const [method, path] of [['POST', '/v2/devices'], ['DELETE', '/v2/devices/1'], ['POST', '/v2/devices/1/assign'], ['DELETE', '/v2/devices/1/assign/1'], ['POST', '/v2/devices/assign']]) await expect(f.request(method, path)).rejects.toMatchObject({ status: 403 });
    const anonymous = await fixture({}, null);
    await expect(anonymous.request('GET', '/v2/devices')).rejects.toMatchObject({ status: 401 });
  });
  it('supports expand=setup,admin with nested Yii fields without disclosing identity secrets', async () => {
    const f = await fixture({ device: devices, control: controls, setup: [{ id: 7, device_id: 1, title: 'Studio', slogans: ['Hello'] }], user: [{ id: 1, tel: '123', nickname: 'Joe', avatar: 'avatar', role: 'root', openid: 'secret', unionid: 'secret' }] });
    const r = await f.request('GET', '/v2/devices/1', {}, { expand: 'setup,admin', fields: 'id,setup.title,admin.id,admin.nickname' });
    expect(r.value).toEqual({ id: 1, setup: { title: 'Studio' }, admin: [{ id: 1, nickname: 'Joe' }] });
  });
  it('updates only associated devices and rejects duplicate UUID validation like Yii', async () => {
    const f = await fixture({ device: devices, control: controls });
    expect((await f.request('PATCH', '/v2/devices/1', { tag: 'updated', unexpected: 'ignored' })).value.tag).toBe('updated');
    expect(f.db.tables.device[0]).not.toHaveProperty('unexpected');
    await expect(f.request('PUT', '/v2/devices/1', { uuid: 'other' })).rejects.toMatchObject({ status: 422 });
  });
  it('validates setup association and prevents reassignment to another controlled device', async () => {
    const f = await fixture({ device: devices, control: [...controls, { id: 2, device_id: 2, user_id: 1 }], setup: [{ id: 7, device_id: 1, title: 'Studio' }] });
    for (const device_id of [0, -1, '1x', null]) await expect(f.request('POST', '/v2/setups', { device_id })).rejects.toMatchObject({ status: 422 });
    await expect(f.request('PUT', '/v2/setups/7', { device_id: 2 })).rejects.toMatchObject({ status: 403 });
    const r = await f.request('PUT', '/v2/setups/7', { device_id: '1', money: 8, shots: [1, 3], slogans: ['a'] });
    expect(r.value).toMatchObject({ id: 7, money: 8, shots: [1, 3], slogans: ['a'] });
  });
  it('creates and deletes associated setups, including Yii 201 and 204 responses', async () => {
    const f = await fixture({ device: devices, control: controls });
    const created = await f.request('POST', '/v2/setups', { device_id: 1, title: 'Studio', pictures: ['pic'] });
    expect(created.status).toBe(201); expect(created.value.pictures).toEqual(['pic']);
    const deleted = await f.request('DELETE', `/v2/setups/${created.value.id}`);
    expect(deleted.status).toBe(204); expect(f.db.tables.setup).toEqual([]);
  });
});

describe('v2 server initialization and rendezvous', () => {
  it('keeps existing status and data when PHP-empty JSON containers are supplied',async()=>{
    const f=await fixture({device:[{id:1,uuid:'existing',version:1}]});
    await f.redis.save('report',{token:'bound',uuid:'existing',device_id:1,status:'ready',data:'previous'});
    await f.request('POST','/v2/server/device',{token:'bound',uuid:'existing',status:[],data:{}},{expand:'device'});
    expect(await f.redis.find('report','bound')).toMatchObject({status:'ready',data:'previous'});
    await expect(f.request('POST','/v2/server/device',{token:[],uuid:'existing'})).rejects.toMatchObject({status:400,message:'token is required'});
  });
  it('treats a zero uuid as an empty value without creating a device',async()=>{
    const f=await fixture();
    const response=await f.request('GET','/v2/server/info',{}, {uuid:'0'});
    expect(response.value).toMatchObject({success:true,data:{scene_id:42,title:'未知'}});
    expect(f.db.tables.device).toEqual([]);
    expect(f.db.tables.setup).toEqual([]);
  });
  it('accepts present empty log tokens and reports the missing required action parameter',async()=>{
    const f=await fixture();
    expect((await f.request('GET','/v2/server/log',{}, {token:''})).value).toEqual({success:true,message:'success',data:{checkin:null,report:null,file:null}});
    await expect(f.request('GET','/v2/server/log')).rejects.toMatchObject({status:400,message:'Missing required parameters: token'});
  });
  it('initializes a device and default configuration from the first dynamic Y1 game', async () => {
    const f = await fixture();
    const r = await f.request('GET', '/v2/server/info', {}, { uuid: 'new' });
    expect(r.value).toMatchObject({ success: true, data: { title: '未知', scene_id: 42 } });
    expect(f.db.tables.device).toHaveLength(1); expect(f.db.tables.setup[0]).toMatchObject({ device_id: 1, money: 0, shots: [1, 5, 10, 20] });
    await f.request('GET', '/v2/server/info', {}, { uuid: 'new' }); expect(f.db.tables.device).toHaveLength(1);
  });
  it('leaves no device or setup when dynamic scene fetching or setup insertion fails', async () => {
    const f = await fixture();
    f.services.catalog.getGames.mockRejectedValueOnce(Object.assign(new Error('Y1 unavailable'), { status: 502 }));
    await expect(f.request('GET', '/v2/server/info', {}, { uuid: 'new' })).rejects.toMatchObject({ status: 502 });
    expect(f.db.tables.device).toEqual([]); expect(f.db.tables.setup).toEqual([]);
    const insert = f.db.insert.bind(f.db); vi.spyOn(f.db, 'insert').mockImplementation(async (table, data) => { if (table === 'setup') throw new Error('SQL failed'); return insert(table, data); });
    await expect(f.request('GET', '/v2/server/info', {}, { uuid: 'new' })).rejects.toThrow('SQL failed');
    expect(f.db.tables.device).toEqual([]);
  });
  it('uses null scene when the Y1 catalog is empty and preserves existing setup', async () => {
    const f = await fixture(); f.services.catalog.getGames.mockResolvedValue([]);
    expect((await f.request('GET', '/v2/server/info', {}, { uuid: 'empty' })).value.data.scene_id).toBeNull();
    await f.db.update('setup', 1, { title: 'custom', scene_id: 99 });
    expect((await f.request('GET', '/v2/server/info', {}, { uuid: 'empty' })).value.data).toMatchObject({ title: 'custom', scene_id: 99 });
  });
  it('coordinates report, authenticated applet and recorded COS file without leaking report internals', async () => {
    const f = await fixture({ device: devices, setup: [{ id: 3, device_id: 1, money: 8, slogans: [], thumbs: [], shots: [] }] });
    const token = 'A0123456789abcdef0123456789abcdef';
    const device = await f.request('POST', '/v2/server/device', { token, uuid: 'mine', status: 'online', data: { x: 1 } }, { expand: 'token,device,setup' });
    expect(device.value.data).toMatchObject({ token, device: { uuid: 'mine', device_id: 1, status: 'online', data: { x: 1 } }, setup: { money: 8 } });
    expect(device.value.data.device).not.toHaveProperty('token');
    await f.request('POST', '/v2/server/applet', { token, id: 'union', status: 'ready' }, { expand: 'applet' });
    const file = await f.request('POST', '/v2/server/file', { token, key: 'movie.mp4' }, { expand: 'file,device,applet' });
    expect(file.value.data.file).toMatchObject({ key: 'movie.mp4', file_id: 1 }); expect(file.value.data.file).not.toHaveProperty('updated_at');
    expect(f.db.tables.file[0]).toMatchObject({ key: 'movie.mp4', unionid: 'union', user_id: 1, type: 'video/mp4', md5: 'abc', size: 256 });
    await f.request('POST', '/v2/server/file', { token, key: 'movie.mp4' }, { expand: 'file' }); expect(f.db.tables.file).toHaveLength(1);
    const log = await f.request('GET', '/v2/server/log', {}, { token }); expect(log.value.data.checkin.user_id).toBe(1);
  });
  it('rejects invalid rendezvous bodies and requires a Bearer identity before applet registration', async () => {
    const f = await fixture();
    await expect(f.request('POST', '/v2/server/device', {})).rejects.toMatchObject({ status: 400 });
    await expect(f.request('POST', '/v2/server/refresh', { token: 'x', uuid: 'a', id: 'b' })).rejects.toMatchObject({ status: 400 });
    const anonymous = await fixture({}, null);
    await expect(anonymous.request('POST', '/v2/server/applet', { token: 'x', id: 'u' })).rejects.toMatchObject({ status: 401 });
    expect(await anonymous.redis.find('applet', 'x')).toBeNull();
    expect((await f.request('POST', '/v2/server/device', { token: 'x', uuid: 'mine' })).value).toMatchObject({ success: false, message: 'need expand', data: [] });
  });
});

describe('v2 file REST contracts', () => {
  it('scopes authenticated file reads and disables direct file writes', async () => {
    const f = await fixture({ file: [{ id: 1, user_id: 1, key: 'a', unionid: 'u', md5: 'a' }, { id: 2, user_id: 2, key: 'b', unionid: 'v', md5: 'b' }] });
    expect((await f.request('GET', '/v2/files/list', {}, { unionid: 'v' })).value.map((r: Row) => r.id)).toEqual([1]);
    expect((await f.request('GET', '/v2/files/1')).value.key).toBe('a');
    await expect(f.request('GET', '/v2/files/2')).rejects.toMatchObject({ status: 404 });
    await expect(f.request('PUT', '/v2/files/1', { unlocked: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(f.request('POST', '/v2/files', { key: 'a' })).rejects.toMatchObject({ status: 404 });
    expect([...f.routes.keys()]).not.toContain('DELETE /v2/files/:id');
  });
});


describe('v2 additional compatibility cases', () => {
  it('exposes the frozen source version column and never mass assigns it', async () => {
    const f = await fixture({ device: [{ ...devices[0], version: 3 }], control: controls });
    expect((await f.request('GET', '/v2/devices/1')).value.version).toBe(3);
    expect((await f.request('PUT', '/v2/devices/1', { version: 99, tag: 'tag' })).value.version).toBe(3);
    await f.request('GET', '/v2/server/info', {}, { uuid: 'new-version' });
    expect(f.db.tables.device[1].version).toBe(0);
  });
  it('uses search-model filters on manage, applies sorting and clamps pages', async () => {
    const f = await fixture({ device: [...devices, { id: 3, uuid: 'second', tag: 'mine-2' }], control: [...controls, { id: 2, user_id: 1, device_id: 3 }] });
    const r = await f.request('GET', '/v2/devices/manage', {}, { 'DeviceSearch[tag]': 'mine', 'per-page': 1, page: 9, sort: '-id' });
    expect(r.value.map((row: Row) => row.id)).toEqual([1]);
    expect(r.headers['x-pagination-total-count']).toBe(2); expect(r.headers['x-pagination-current-page']).toBe(2);
    expect(r.headers.link).toContain('rel="prev"');
  });
  it('persists a blank setup on expand as the legacy model does', async () => {
    const f = await fixture({ device: devices, control: controls });
    const r = await f.request('GET', '/v2/devices/1', {}, { expand: 'setup' });
    expect(r.value.setup).toEqual({id:1,device_id:1,updated_at:{expression:'NOW()',params:[]}});
    expect(f.db.tables.setup).toHaveLength(1);
    await f.request('GET', '/v2/devices/1', {}, { expand: 'setup' }); expect(f.db.tables.setup).toHaveLength(1);
  });
  it('supports wildcard fields and keeps v2 setup listings under control scope', async () => {
    const f = await fixture({ device: devices, control: controls, setup: [{ id: 1, device_id: 1, title: 'mine' }, { id: 2, device_id: 2, title: 'other' }] });
    expect((await f.request('GET', '/v2/devices/1', {}, { fields: '*' })).value.uuid).toBe('mine');
    expect((await f.request('GET', '/v2/setups')).value.map((r: Row) => r.id)).toEqual([1]);
    for (const [method, body] of [['GET', {}], ['PUT', { title: 'bad' }], ['DELETE', {}]] as const) await expect(f.request(method, '/v2/setups/2', body)).rejects.toMatchObject({ status: 404 });
    await expect(f.request('POST', '/v2/setups', { device_id: 2 })).rejects.toMatchObject({ status: 404 });
  });
  it('uses the core device signature validator on public refresh routes before any writes', async () => {
    const f = await fixture();
    const auth = new AuthService(f.db as any, { devAuth: false });
    f.services.auth.requireDevice = auth.requireDevice.bind(auth);
    const token = 'A0123456789abcdef0123456789abcdef', time = '1000', uuid = 'signed';
    await expect(f.request('POST', '/v2/server/device', { token, uuid })).rejects.toMatchObject({ status: 400 });
    await expect(f.request('POST', '/v2/server/device', { token, uuid }, { time, hash: 'invalid' })).rejects.toMatchObject({ status: 400 });
    expect(f.db.tables.device).toEqual([]); expect(await f.redis.find('report', token)).toBeNull();
    const hash = createHash('md5').update(token + time + uuid + 'buj1aban.c0m').digest('hex');
    expect((await f.request('POST', '/v2/server/device', { token, uuid }, { time, hash, expand: 'device' })).value.data.device.uuid).toBe(uuid);
  });
  it('returns null file until applet registration and does not erase status on empty refresh', async () => {
    const f = await fixture();
    const token = 'A0123456789abcdef0123456789abcdef';
    const absent = await f.request('POST', '/v2/server/file', { token, key: 'a.mp4' }, { expand: 'file,applet,device' });
    expect(absent.value.data).toEqual({ file: null, applet: [], device: [] }); expect(f.services.integrations.fileMetadata).not.toHaveBeenCalled();
    await f.request('POST', '/v2/applet/refresh', { token, id: 'union', status: 'ready', data: 'payload' }, { expand: 'applet' });
    const unchanged = await f.request('POST', '/v2/server/applet', { token, id: 'union', status: '', data: '' }, { expand: 'applet' });
    expect(unchanged.value.data.applet).toMatchObject({ status: 'ready', data: 'payload', user_id: 1 });
  });
  it('rejects removed file writes while exposing owned reads and scene/test endpoints', async () => {
    const f = await fixture({ file: [{ id: 1, key: 'a', md5: 'same' }] });
    for (const body of [{}, { key: 'b', size: 1.5 }, { key: 'b', user_id: 9 }, { key: 'b', md5: 'same' }]) await expect(f.request('POST', '/v2/files', body)).rejects.toMatchObject({ status: 404 });
    await expect(f.request('GET', '/v2/files/9')).rejects.toMatchObject({ status: 404 });
    expect((await f.request('GET', '/v2/files/list')).value).toEqual([]);
    await expect(f.request('GET', '/v2/server/info')).rejects.toMatchObject({ status: 400 });
    expect((await f.request('GET', '/v2/server/scenes')).value).toEqual([{ verse_id: 42, name: 'Y1' }]);
    expect((await f.request('GET', '/v2/server/test')).value).toBe('2');
    expect((await f.request('GET', '/v2/server/log', {}, { token: 'absent' })).value.data).toEqual({ checkin: null, report: null, file: null });
    await expect(f.request('GET', '/v2/server/refresh')).rejects.toMatchObject({ status: 400 });
  });
});


describe('v2 provider pagination and HTTP headers', () => {
  it('returns the complete owned file list newest first without provider headers', async () => {
    const f = await fixture({ file: [{ id: 1, user_id: 1, key: 'a', unionid: 'u' }, { id: 2, user_id: 1, key: 'b', unionid: 'u' }, { id: 3, user_id: 1, key: 'c', unionid: 'u' }] });
    const r = await f.request('GET', '/v2/files/list', {}, { unionid: 'u', 'per-page': 1, page: 2, sort: '-id' });
    expect(r.value.map((row: Row) => row.id)).toEqual([3,2,1]);
    expect(r.headers['x-pagination-total-count']).toBeUndefined();
  });
  it('sets absolute Yii Location headers for newly created setups', async () => {
    const f = await fixture({ device: devices, control: controls });
    const setup = await f.request('POST', '/v2/setups', { device_id: 1 });
    expect(setup.headers.location).toBe('http://localhost/v2/setups/1');
  });
  it('accepts a nonempty unknown expand list as a successful empty response', async () => {
    const f = await fixture();
    const r = await f.request('POST', '/v2/server/refresh', { token: 'x', uuid: 'a' }, { expand: ',,,' });
    expect(r.value).toEqual({ data: [], success: true, message: 'success' });
  });
});


describe('v2 existing applet hash protocol compatibility', () => {
  it('updates an existing applet through server routes with no Bearer or an expired Bearer', async () => {
    const f = await fixture({}, null);
    const token = 'A0123456789abcdef0123456789abcdef', id = 'union', time = '1000';
    const key = 'test-key';
    f.services.auth = new AuthService(f.db as any, { jwtKey: key, devAuth: false });
    const expired = new AuthService(f.db as any, { jwtKey: key, now: () => Date.now() - 25 * 3600000 }).issue({ id: 1 }, 'v2-user', 'http://localhost').accessToken;
    await f.redis.save('applet', { token, id, user_id: 1, status: 'ready', created_at: '1' });
    const hash = createHash('md5').update(token + time + id + 'buj1aban.c0m').digest('hex');
    const unsigned = await f.request('POST', '/v2/server/applet', { token, id, status: 'linked' }, { time, hash, expand: 'applet' });
    expect(unsigned.value.data.applet).toMatchObject({ user_id: 1, status: 'linked' });
    const stale = await f.request('POST', '/v2/server/refresh', { token, id, status: 'over' }, { time, hash, expand: 'applet' }, { authorization: `Bearer ${expired}` });
    expect(stale.value.data.applet).toMatchObject({ user_id: 1, status: 'over' });
    await expect(f.request('POST', '/v2/server/applet', { token, id, status: 'bad' }, { time, hash: 'invalid' })).rejects.toMatchObject({ status: 400 });
    expect((await f.redis.find('applet', token))!.status).toBe('over');
    await expect(f.request('POST', '/v2/applet/refresh', { token, id }, { time, hash })).rejects.toMatchObject({ status: 401 });
    await expect(f.request('POST', '/v2/applet/refresh', { token, id }, { time, hash }, { authorization: `Bearer ${expired}` })).rejects.toMatchObject({ status: 401 });
  });
  it('requires a valid Bearer before creating a new applet even with a valid device hash', async () => {
    const f = await fixture({}, null);
    const token = 'B0123456789abcdef0123456789abcdef', id = 'new-union', time = '1000';
    const key = 'test-key';
    f.services.auth = new AuthService(f.db as any, { jwtKey: key, devAuth: false });
    const hash = createHash('md5').update(token + time + id + 'buj1aban.c0m').digest('hex');
    const expired = new AuthService(f.db as any, { jwtKey: key, now: () => Date.now() - 25 * 3600000 }).issue({ id: 1 }, 'v2-user', 'http://localhost').accessToken;
    await expect(f.request('POST', '/v2/server/applet', { token, id }, { time, hash })).rejects.toMatchObject({ status: 401 });
    await expect(f.request('POST', '/v2/server/refresh', { token, id }, { time, hash }, { authorization: `Bearer ${expired}` })).rejects.toMatchObject({ status: 401 });
    expect(await f.redis.find('applet', token)).toBeNull();
  });
});


describe('v2 public scene pass-through', () => {
  it('preserves the single-page upstream envelope instead of the admin complete catalog', async () => {
    const f = await fixture();
    f.services.catalog.forwardCheckin.mockResolvedValue({ success: true, data: { items: [{ verse_id: 42, name: 'Y1' }] } });
    const response = await f.request('GET', '/v2/server/scenes');
    expect(response.value).toEqual({ success: true, data: { items: [{ verse_id: 42, name: 'Y1' }] } });
    expect(f.services.catalog.forwardCheckin).toHaveBeenCalledOnce();
    expect(f.services.catalog.fetchScenes).not.toHaveBeenCalled();
  });
});

describe('v2 Yii wildcard field compatibility', () => {
  const setup = { id: 7, device_id: 1, title: 'Studio', money: 8 };
  const user = { id: 1, tel: '123', nickname: 'Joe', avatar: 'avatar', role: 'manager', openid: 'secret' };
  it('expands nested administrator wildcards to all public user fields', async () => {
    const f = await fixture({ device: devices, control: controls, setup: [setup], user: [user] });
    const response = await f.request('GET', '/v2/devices/1', {}, { expand: 'admin', fields: 'id,admin.*' });
    expect(response.value).toEqual({ id: 1, admin: [{ id: 1, tel: '123', nickname: 'Joe', avatar: 'avatar', role: 'manager' }] });
  });
  it('retains nested field selections alongside a root wildcard', async () => {
    const f = await fixture({ device: devices, control: controls, setup: [setup], user: [user] });
    const response = await f.request('GET', '/v2/devices/1', {}, { expand: 'setup,admin', fields: '*,setup.title,admin.id' });
    expect(response.value).toMatchObject({ id: 1, uuid: 'mine' });
    expect(response.value.setup).toEqual({ title: 'Studio' });
    expect(response.value.admin).toEqual([{ id: 1 }]);
  });
});

describe('v2 current game device version reporting', () => {
  it('stores explicit and omitted versions when device registration creates a device', async () => {
    const f = await fixture();
    await f.request('POST', '/v2/server/device', { token: 'explicit', uuid: 'explicit', version: 2 }, { expand: 'device' });
    await f.request('POST', '/v2/server/refresh', { token: 'default', uuid: 'default' }, { expand: 'device' });
    expect(f.db.tables.device.map(row => ({ uuid: row.uuid, version: row.version }))).toEqual([{ uuid: 'explicit', version: 2 }, { uuid: 'default', version: 0 }]);
  });
  it('synchronizes an existing bound report on every UUID login without touching timestamps', async () => {
    const f = await fixture({ device: [{ id: 1, uuid: 'existing', version: 9, updated_at: '2026-10-22 12:00:00' }] });
    await f.redis.save('report', { token: 'bound', uuid: 'existing', device_id: 1 });
    for (const version of [0, '6', '0', '2147483647', '+2', ' 3 ', '-0', '\t\n\v\r1\t\n\v\r']) {
      await f.request('POST', '/v2/server/device', { token: 'bound', uuid: 'existing', version }, { expand: 'device' });
      expect(f.db.tables.device[0].version).toBe(Number(version) || 0);
      expect(f.db.tables.device[0].updated_at).toBe('2026-10-22 12:00:00');
    }
    await f.request('POST', '/v2/server/refresh', { token: 'bound', uuid: 'existing' }, { version: 5, expand: 'device' });
    expect(f.db.tables.device[0].version).toBe(0);
    expect(f.db.tables.device).toHaveLength(1);
  });
  it('rejects invalid version bodies before creating or changing devices or Redis reports', async () => {
    for (const version of [true, false, null, [], {}, -1, 1.5, '1.5', 2147483648, '2147483648', '', '01', '1e0', '0x1', '\f1\f']) {
      const f = await fixture();
      await expect(f.request('POST', '/v2/server/device', { token: 'invalid', uuid: 'invalid', version }, { expand: 'device' })).rejects.toMatchObject({ status: 400, message: 'version must be an integer between 0 and 2147483647' });
      expect(f.db.tables.device).toEqual([]);
      expect(await f.redis.find('report', 'invalid')).toBeNull();
    }
    const f = await fixture({ device: [{ id: 1, uuid: 'existing', version: 9 }] });
    await f.redis.save('report', { token: 'bound', uuid: 'existing', device_id: 1, status: 'ready' });
    await expect(f.request('POST', '/v2/server/refresh', { token: 'bound', uuid: 'existing', version: '\f1\f', status: 'running' })).rejects.toMatchObject({ status: 400 });
    expect(f.db.tables.device[0].version).toBe(9);
    expect((await f.redis.find('report', 'bound'))!.status).toBe('ready');
  });
  it('does not apply version validation or synchronization to file and applet refreshes', async () => {
    const f = await fixture({ device: [{ id: 1, uuid: 'existing', version: 9 }] });
    await f.redis.save('report', { token: 'bound', uuid: 'existing', device_id: 1 });
    await f.request('POST', '/v2/server/file', { token: 'bound', key: 'read-only', version: null }, { expand: 'device' });
    await f.request('POST', '/v2/applet/refresh', { token: 'bound', id: 'union', version: false }, { expand: 'device' });
    expect(f.db.tables.device[0].version).toBe(9);
  });
  it('continues to reject invalid device signatures before version synchronization', async () => {
    const f = await fixture({ device: [{ id: 1, uuid: 'existing', version: 9 }] });
    f.services.auth = new AuthService(f.db as any, { devAuth: false });
    const token = 'A0123456789abcdef0123456789abcdef';
    await expect(f.request('POST', '/v2/server/device', { token, uuid: 'existing', version: 2 }, { time: '1000', hash: 'invalid' })).rejects.toMatchObject({ status: 400 });
    expect(f.db.tables.device[0].version).toBe(9);
    expect(await f.redis.find('report', token)).toBeNull();
  });
});
