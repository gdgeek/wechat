import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { describe, expect, test, beforeEach } from 'vitest';
import type { Context, Row, Services } from '../src/core/contracts';

class TestDatabase {
  sqlite = new DatabaseSync(':memory:');
  constructor() {
    this.sqlite.exec(`
      CREATE TABLE player (id INTEGER PRIMARY KEY AUTOINCREMENT, tel TEXT NOT NULL UNIQUE, openId TEXT UNIQUE, nickname TEXT, avatar TEXT, info JSON, recharge REAL DEFAULT 0, cost REAL DEFAULT 0, give REAL DEFAULT 0, points INTEGER DEFAULT 0, times INTEGER DEFAULT 0, grade INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
      CREATE TABLE manager (id INTEGER PRIMARY KEY, player_id INTEGER UNIQUE, type TEXT, device_id INTEGER);
      CREATE TABLE shop (id INTEGER PRIMARY KEY, price INTEGER DEFAULT 10, rate INTEGER DEFAULT 80, play_time INTEGER DEFAULT 60, advanced INTEGER DEFAULT 0, tag TEXT, info JSON, created_at TEXT, updated_at TEXT);
      CREATE TABLE device (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, tag TEXT UNIQUE, shop_id INTEGER, version INTEGER NOT NULL DEFAULT 0, ip TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE operation (id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, pool INTEGER DEFAULT 0, income INTEGER DEFAULT 0, turnover INTEGER DEFAULT 0);
      CREATE TABLE record (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER NOT NULL, player_id INTEGER NOT NULL, status TEXT DEFAULT 'ready', game JSON, startTime TEXT, endTime TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE award (id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, type TEXT, price INTEGER DEFAULT 100, UNIQUE(shop_id,type));
      CREATE TABLE gift (id INTEGER PRIMARY KEY AUTOINCREMENT, award_id INTEGER NOT NULL, uuid TEXT UNIQUE, tag TEXT, picture TEXT, info JSON, created_at TEXT, updated_at TEXT);
      CREATE TABLE file (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, unionid TEXT, user_id INTEGER, token TEXT, type TEXT, created_at TEXT, md5 TEXT UNIQUE, unlocked INTEGER DEFAULT 0);
    `);
  }
  async query(sql: string, params: any[] = []): Promise<Row[]> {
    const q = sql.replace(/ FOR UPDATE\b/g, '');
    const statement = this.sqlite.prepare(q);
    if (/^\s*(SELECT|PRAGMA)/i.test(q)) {
      return statement.all(...params).map(raw => Object.fromEntries(Object.entries(raw).map(([k,v]) => [k, ['game','info'].includes(k) && typeof v === 'string' ? JSON.parse(v) : v])));
    }
    statement.run(...params); return [];
  }
  async one(sql: string, params: any[] = []) { return (await this.query(sql, params))[0] ?? null; }
  async insert(table: string, data: Row) {
    const keys = Object.keys(data);
    const result = this.sqlite.prepare(`INSERT INTO \`${table}\` (${keys.map(k => '`'+k+'`').join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => typeof data[k] === 'object' && data[k] !== null ? JSON.stringify(data[k]) : data[k]));
    return this.one(`SELECT * FROM \`${table}\` WHERE id = ?`, [Number(result.lastInsertRowid)]);
  }
  async update(table: string, id: any, data: Row) {
    const keys = Object.keys(data);
    if (keys.length) this.sqlite.prepare(`UPDATE \`${table}\` SET ${keys.map(k => '`'+k+'` = ?').join(',')} WHERE id = ?`).run(...keys.map(k => typeof data[k] === 'object' && data[k] !== null ? JSON.stringify(data[k]) : data[k]), id);
    return this.one(`SELECT * FROM \`${table}\` WHERE id = ?`, [id]);
  }
  async delete(table: string, id: any) { this.sqlite.prepare(`DELETE FROM \`${table}\` WHERE id = ?`).run(id); }
  async columns(table: string) { return this.sqlite.prepare(`PRAGMA table_info(\`${table}\`)`).all().map((r: any) => ({ name: r.name, type: r.type, nullable: !r.notnull, default: r.dflt_value, key: r.pk ? 'PRI' : '' })); }
  async transaction<T>(fn: (db: TestDatabase) => Promise<T>): Promise<T> {
    this.sqlite.exec('BEGIN');
    try { const result = await fn(this); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
class TestRedis {
  data = new Map<string, Row>();
  async find(model: string, pk: string) { return structuredClone(this.data.get(model+':'+pk) ?? null); }
  async all(model: string) { return [...this.data.entries()].filter(([k]) => k.startsWith(model+':')).map(([,v]) => structuredClone(v)); }
  async save(model: string, row: Row) { this.data.set(model+':'+row.token, structuredClone(row)); return row; }
  async remove(model: string, pk: string) { this.data.delete(model+':'+pk); }
}

let db: TestDatabase, redis: TestRedis, services: Services, routes: Map<string, (c: Context) => any>, identity: Row;
async function boot() {
  const implementation = await import('../src/v1/index').catch(() => null);
  expect(implementation?.registerV1, 'V1 must register the legacy business routes').toBeTypeOf('function');
  implementation!.registerV1({ add(method: string | string[], path: string, handler: any) { for (const verb of Array.isArray(method) ? method : [method]) routes.set(verb+':'+path, handler); } } as any, services);
}
function context(body: Row = {}, query: Row = {}, params: Row = {}): Context {
  return { body, query, params, req: { ip: '127.0.0.1', method: 'POST', protocol: 'https', headers: {host:'game.test'}, get: () => 'game.test' } as any,
    res: { status() {return this;}, setHeader() {}, header() {}, set() {} } as any };
}
async function call(method: string, path: string, body: Row = {}, query: Row = {}, params: Row = {}) {
  const handler = routes.get(method+':'+path); expect(handler, method+' '+path).toBeTypeOf('function'); return handler!(context(body,query,params));
}
beforeEach(async () => {
  db = new TestDatabase(); redis = new TestRedis(); routes = new Map(); identity = {id:1};
  services = {db,redis,auth:{ bearer: async () => identity, playerFingerprint: () => {}, issue: () => ({accessToken:'signed-access',refreshToken:'signed-refresh'}), refresh: async () => identity, verify: async () => identity }, integrations:{codeSession:async () => ({openid:'verified'})}} as unknown as Services;
  await db.insert('player',{id:1,tel:'manager',recharge:100});
  await db.insert('player',{id:2,tel:'player',recharge:100,points:50});
  await db.insert('manager',{id:1,player_id:1,type:'staff'});
  await db.insert('shop',{id:1,price:10,rate:80,play_time:60});
  await db.insert('device',{id:1,uuid:'device-1',shop_id:1});
  await db.insert('operation',{id:1,shop_id:1,pool:0,income:0,turnover:0});
});

describe('v1 business parity', () => {
  test('registers all real custom endpoints and inherited REST', async () => {
    await boot();
    for (const route of ['GET:/v1/common/test','POST:/v1/common/sign-up','GET:/v1/system/ready-game','POST:/v1/system/close-record','POST:/v1/system/deduct-points','GET:/v1/game/device','POST:/v1/game/finish','GET:/v1/local/log','POST:/v1/local/refresh','POST:/v1/checkin/upload','POST:/v1/checkin/report','GET:/v1/checkin/files','GET:/v1/web/async-routes','GET:/v1/gift','PUT:/v1/shop/:id','GET:/v1/game/:id','GET:/v1/helper/:id']) expect(routes.has(route),route).toBe(true);
  });
  test('game reservation charges once and finishing clamps points to budget', async () => {
    await boot();
    const ready = await call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1});
    expect(ready.record.game).toEqual({points:expect.any(Number),secodes:60});
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.cost).toBe(10);
    expect((await db.one('SELECT * FROM operation WHERE id = 1'))!.turnover).toBe(10);
    await expect(call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1})).rejects.toThrow('Already Running');
    await call('POST','/v1/game/start',{}, {uuid:'device-1'});
    const over = await call('POST','/v1/game/finish',{points:999}, {uuid:'device-1'});
    expect(over.player.points).toBe(50+ready.record.game.points);
    expect(over.player.times).toBe(1);
    expect(await db.one('SELECT * FROM record')).toBeNull();
  });
  test('insufficient balance rolls back every reservation mutation', async () => {
    await boot(); await db.update('player',2,{recharge:1});
    await expect(call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1})).rejects.toThrow('Not Enough Money');
    expect((await db.one('SELECT * FROM operation WHERE id = 1'))!.turnover).toBe(0);
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.cost).toBe(0);
    expect(await db.one('SELECT * FROM record')).toBeNull();
  });
  test('closing a reserved game reverses the financial movement', async () => {
    await boot(); const ready = await call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1});
    await call('POST','/v1/system/close-record',{recordId:ready.record.id});
    expect(await db.one('SELECT * FROM record')).toBeNull();
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.cost).toBe(0);
    expect(await db.one('SELECT pool,income,turnover FROM operation WHERE id = 1')).toEqual({pool:0,income:0,turnover:0});
  });
  test('non-manager cannot deduct another player points', async () => {
    await boot(); identity={id:2};
    await expect(call('POST','/v1/system/deduct-points',{targetId:1,points:10})).rejects.toThrow('Not Manager');
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.points).toBe(50);
  });
  test('checkin state retains uploads and closes only matching owner', async () => {
    await boot();
    await call('POST','/v1/checkin/status-ready',{token:'session',openid:'owner'});
    await call('POST','/v1/checkin/upload',{token:'session',key:'upload.jpg'});
    await call('POST','/v1/checkin/status-linked',{token:'session',openid:'owner'});
    const result = await call('GET','/v1/checkin/status',{}, {token:'session'});
    expect(result.data.checkin.status).toBe('linked'); expect(result.data.file.key).toBe('upload.jpg');
    expect((await call('POST','/v1/checkin/status-over',{token:'session',openid:'intruder'})).success).toBe(false);
    expect((await call('POST','/v1/checkin/status-over',{token:'session',openid:'owner'})).success).toBe(true);
  });
  test('local refresh rejects invalid signature without creating state', async () => {
    await boot();
    await expect(call('POST','/v1/local/refresh',{token:'A'+'a'.repeat(32),device:'AR'},{time:'1',hash:'wrong'})).rejects.toThrow('hash error');
    expect(await redis.all('report')).toEqual([]);
  });
  test('local refresh persists report and reads the corresponding checkin', async () => {
    await boot(); const token='A'+'a'.repeat(32), time='123';
    await redis.save('checkin',{token,openid:'owner',status:'ready'});
    const hash=createHash('md5').update(token+time+'AR'+'buj1aban.c0m').digest('hex');
    const result=await call('POST','/v1/local/refresh',{token,device:'AR',status:'running',data:{score:3}},{time,hash});
    expect(result.data.report).toMatchObject({token,device:'AR',status:'running',data:{score:3}});
    expect(result.data.checkin.openid).toBe('owner');
  });
  test('REST validates foreign keys and supports award filtering and expansions', async () => {
    await boot();
    await expect(call('POST','/v1/award',{shop_id:999})).rejects.toThrow();
    const award=await call('POST','/v1/award',{shop_id:1,type:'small'});
    expect(award.price).toBe(100);
    await call('POST','/v1/gift',{award_id:award.id,uuid:'gift-1'});
    const result=await call('GET','/v1/shop/:id',{}, {expand:'awards,gifts,operation'}, {id:'1'});
    expect(result.awards).toHaveLength(1); expect(result.gifts).toHaveLength(1);
    expect(result.operation).toEqual({pool:0,income:0,turnover:0});
    expect(await call('GET','/v1/award',{}, {shop_id:999})).toEqual([]);
  });
  test('signup stores one player and returns a signed v1 identity', async () => {
    await boot();
    const signed=await call('POST','/v1/common/sign-up',{openId:'new-open',tel:'new-player'});
    expect(signed).toMatchObject({success:true,player:{openId:'new-open',role:'player'},token:{accessToken:'signed-access'}});
    const again=await call('POST','/v1/common/sign-up',{openId:'new-open',tel:'new-player'});
    expect(again.message).toBe('already signup');
    expect(await db.query('SELECT * FROM player WHERE openId = ?', ['new-open'])).toHaveLength(1);
  });
});

describe('v1 REST and failure contracts', () => {
  test('field wildcard preserves default attributes and explicit expansions', async () => {
    await boot();
    const all=await call('GET','/v1/player/:id',{}, {fields:'*',expand:'role'}, {id:'2'});
    expect(all).toMatchObject({id:2,tel:'player',points:50,role:'player'});
    const selected=await call('GET','/v1/player/:id',{}, {fields:'id,tel',expand:'role'}, {id:'2'});
    expect(selected).toEqual({id:2,tel:'player',role:'player'});
  });
  test('REST pagination exposes Yii pagination headers and deterministic requested ordering', async () => {
    await boot();
    const headers:Row={};const ctx=context({}, {'per-page':'1',page:'2',sort:'-id',fields:'id,tel'});
    ctx.res.setHeader=((key:string,value:any)=>{headers[key]=value;return ctx.res;}) as any;
    const response=await routes.get('GET:/v1/player')!(ctx);
    expect(response).toEqual([{id:1,tel:'manager'}]);
    expect(headers).toMatchObject({'X-Pagination-Total-Count':'2','X-Pagination-Page-Count':'2','X-Pagination-Current-Page':'2','X-Pagination-Per-Page':'1'});
    expect(headers.Link).toContain('page=1');
  });
  test('record insertion failure rolls back charged player and operation', async () => {
    await boot();db.sqlite.exec("CREATE TRIGGER reject_record BEFORE INSERT ON record BEGIN SELECT RAISE(FAIL, 'storage rejected'); END;");
    await expect(call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1})).rejects.toThrow('storage rejected');
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.cost).toBe(0);
    expect(await db.one('SELECT pool,income,turnover FROM operation WHERE id = 1')).toEqual({pool:0,income:0,turnover:0});
  });
  test('a second finish cannot award the same budget again', async () => {
    await boot();await call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1});
    await call('POST','/v1/game/start',{}, {uuid:'device-1'});
    await call('POST','/v1/game/finish',{points:5},{uuid:'device-1'});
    const first=await db.one('SELECT * FROM player WHERE id = 2');
    await expect(call('POST','/v1/game/finish',{points:5},{uuid:'device-1'})).rejects.toThrow('No record');
    expect(await db.one('SELECT * FROM player WHERE id = 2')).toEqual(first);
  });
  test('legacy give validates money without changing financial balances', async () => {
    await boot();const original=await db.one('SELECT * FROM player WHERE id = 2');
    await call('POST','/v1/system/give',{targetId:2,money:10});
    const saved=await db.one('SELECT * FROM player WHERE id = 2');
    expect(saved!.recharge).toBe(original!.recharge);expect(saved!.give).toBe(original!.give);
  });
  test('REST blocks missing authentication before listing data', async () => {
    await boot();services.auth.bearer=async () => {throw new Error('Unauthorized');};
    await expect(call('GET','/v1/device')).rejects.toThrow('Unauthorized');
  });
  test('duplicate identity and invalid integer updates return validation errors without persistence', async () => {
    await boot();
    await expect(call('POST','/v1/player',{tel:'player'})).rejects.toMatchObject({status:422});
    await expect(call('PATCH','/v1/player/:id',{points:'1.5'}, {}, {id:'2'})).rejects.toMatchObject({status:422});
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.points).toBe(50);
    expect(await db.query('SELECT * FROM player')).toHaveLength(2);
  });
  test('refresh uses only validated v1 refresh token from body and returns legacy token envelope', async () => {
    await boot();let received:any;
    services.auth.refresh=async (...args:any[]) => {received=args;return {accessToken:'new-access',refreshToken:'new-refresh',expires:'2026/10/23 12:00:00'};};
    expect(await call('POST','/v1/common/refresh-token',{refreshToken:'body-refresh'})).toMatchObject({success:true,message:'refresh success',token:{accessToken:'new-access'}});
    expect(received).toEqual(['body-refresh','v1-player','https://game.test']);
  });
  test('local key refresh stores a SQL file linked to its Redis record', async () => {
    await boot();const token='B'+'b'.repeat(32),time='321',key='new.jpg';
    await redis.save('checkin',{token,openid:'owner',unionid:'union-owner'});
    const hash=createHash('md5').update(token+time+key+'buj1aban.c0m').digest('hex');
    const response=await call('POST','/v1/local/refresh',{token,key},{time,hash});
    expect(response.data.file).toMatchObject({token,key,dbid:expect.any(Number)});
    expect(await db.one('SELECT * FROM file WHERE id = ?',[response.data.file.dbid])).toMatchObject({key,unionid:'union-owner'});
  });
  test('game device JSON derives unset unused and running statuses', async () => {
    await boot();
    expect((await call('GET','/v1/game/device',{}, {uuid:'new-device'})).device.status).toBe('unset');
    expect((await call('GET','/v1/device/:id',{}, {}, {id:'1'})).status).toBe('unused');
    await call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1});
    await call('POST','/v1/game/start',{}, {uuid:'device-1'});
    const response=await call('GET','/v1/device/:id',{}, {}, {id:'1'});
    expect(response.status).toBe('running');expect(response.created_at).toBeUndefined();
  });
});

 test('new device version initializes to one and client writes cannot change it', async () => {
   await boot();
   const created=await call('POST','/v1/device',{uuid:'versioned',version:99});
   expect(created.version).toBe(1);
   const changed=await call('PATCH','/v1/device/:id',{tag:'new-tag',version:100}, {}, {id:String(created.id)});
   expect(changed.version).toBe(1);
 });

test('v1 Redis responses include every declared attribute and hide v2-only fields', async () => {
  await boot();await redis.save('report',{token:'shared',uuid:'v2-device',device_id:1,status:'running'});
  const response=await call('GET','/v1/local/log',{}, {token:'shared'});
  expect(response.data.report).toEqual({token:'shared',device:null,status:'running',data:null,setup:null,created_at:null,updated_at:null});
});

describe('v1 Yii serialization regressions',()=>{
  test('numeric balance fields reject JSON booleans and arrays before writing',async()=>{
    await boot();const original=await db.one('SELECT * FROM player WHERE id = 2');
    for (const field of ['recharge','cost','give']) {
      for (const value of [true,false,[100],{},'0x10',' ','1.']) {
        await expect(call('PATCH','/v1/player/:id',{[field]:value},{},{id:'2'})).rejects.toMatchObject({status:422});
        expect(await db.one('SELECT * FROM player WHERE id = 2')).toEqual(original);
      }
    }
  });
  test('optional numeric fields skip empty array validation and cast them to zero as Yii does',async()=>{
    await boot();
    expect(await call('PATCH','/v1/player/:id',{recharge:[],cost:[],give:[],points:[],times:[],grade:[]},{},{id:'2'})).toMatchObject({recharge:0,cost:0,give:0,points:0,times:0,grade:0});
  });
  test('numeric balance fields retain Yii decimal and exponent string support',async()=>{
    await boot();
    expect((await call('PATCH','/v1/player/:id',{recharge:'1.25e2',cost:'.5',give:'-2.5'},{},{id:'2'}))).toMatchObject({recharge:125,cost:.5,give:-2.5});
  });
  test('integer fields reject numeric JSON arrays instead of coercing them',async()=>{
    await boot();
    await expect(call('PATCH','/v1/player/:id',{points:[100]},{},{id:'2'})).rejects.toMatchObject({status:422});
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.points).toBe(50);
  });
  test('validation errors and empty inputs skip foreign and unique database lookups',async()=>{
    await boot();
    const original=db.one.bind(db);let unsafeLookup=false;
    db.one=async(sql:string,params:any[]=[])=>{
      if (params.some(value=>typeof value==='boolean' || value!==null && typeof value==='object')) unsafeLookup=true;
      return original(sql,params);
    };
    for (const [table,body] of [['award',{shop_id:[]}],['award',{shop_id:true}],['record',{player_id:2,device_id:[1]}],['player',{tel:{bad:'type'}}]] as const) {
      await expect(call('POST','/v1/'+table,body)).rejects.toMatchObject({status:422});
    }
    expect(unsafeLookup).toBe(false);
    expect(await db.query('SELECT * FROM award')).toEqual([]);
    expect(await db.query('SELECT * FROM record')).toEqual([]);
  });
  test('device version participates in inherited REST sorting and pagination',async()=>{
    await boot();await db.update('device',1,{version:2});
    await db.insert('device',{id:2,uuid:'older',version:1});await db.insert('device',{id:3,uuid:'newer',version:8});
    expect(await call('GET','/v1/device',{}, {sort:'-version','per-page':1,page:2,fields:'id,version'})).toEqual([{id:1,version:2}]);
  });
  test('inherited REST sorting uses only the first valid attribute as Yii does',async()=>{
    await boot();await db.update('device',1,{version:1});await db.insert('device',{id:2,uuid:'second',version:1});
    expect(await call('GET','/v1/device',{}, {sort:'unknown,version,-id',fields:'id'})).toEqual([{id:1},{id:2}]);
  });
  test('award default price applies to explicit null or empty updates',async()=>{
    await boot();const award=await call('POST','/v1/award',{shop_id:1,price:200,type:'s'});
    expect((await call('PATCH','/v1/award/:id',{price:null},{},{id:String(award.id)})).price).toBe(100);
    await call('PATCH','/v1/award/:id',{price:250},{},{id:String(award.id)});
    expect((await call('PATCH','/v1/award/:id',{price:''},{},{id:String(award.id)})).price).toBe(100);
    await call('PATCH','/v1/award/:id',{price:300},{},{id:String(award.id)});
    expect((await call('PATCH','/v1/award/:id',{type:'m'},{},{id:String(award.id)})).price).toBe(300);
  });
  test('award empty array prices receive the default hundred on create and update',async()=>{
    await boot();
    const award=await call('POST','/v1/award',{shop_id:1,price:[],type:'s'});
    expect(award.price).toBe(100);
    await call('PATCH','/v1/award/:id',{price:250},{},{id:String(award.id)});
    expect((await call('PATCH','/v1/award/:id',{price:[]},{},{id:String(award.id)})).price).toBe(100);
  });
  test('record device expansion obeys nested fields without exposing the full row',async()=>{
    await boot();const row=await db.insert('record',{device_id:1,player_id:2,game:{points:1,secodes:60}});
    const selected=await call('GET','/v1/record/:id',{}, {expand:'device',fields:'id,device.id'}, {id:String(row!.id)});
    expect(selected).toEqual({id:row!.id,device:{id:1}});
  });
  test('shop award and gift expansions propagate nested field selections',async()=>{
    await boot();const award=await call('POST','/v1/award',{shop_id:1,type:'s'});
    const gift=await call('POST','/v1/gift',{award_id:award.id,uuid:'nested-gift',tag:'private-tag'});
    const selected=await call('GET','/v1/shop/:id',{}, {expand:'awards,gifts',fields:'id,awards.id,gifts.id'}, {id:'1'});
    expect(selected).toEqual({id:1,awards:[{id:award.id}],gifts:[{id:gift.id}]});
  });
  test('REST creation emits an absolute Location URL with the route identity',async()=>{
    await boot();const headers:Row={},ctx=context({uuid:'absolute-device'});
    ctx.res.setHeader=((key:string,value:any)=>{headers[key]=value;return ctx.res;}) as any;
    const created=await routes.get('POST:/v1/device')!(ctx);
    expect(headers.Location).toBe('https://game.test/v1/device/'+created.id);
  });
});
