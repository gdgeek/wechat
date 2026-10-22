import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Database } from '../src/core/database';
import { ApiRouter } from '../src/core/router';
import { registerV1 } from '../src/v1';
import type { Context, Row, Services } from '../src/core/contracts';

const testUrl=process.env.V1_MYSQL_TEST_URL;
describe.skipIf(!testUrl)('v1 real MySQL migration and financial parity', () => {
  let pool:Pool, db:Database, router:ApiRouter;
  beforeAll(async () => {
    const url=new URL(testUrl!);
    if (url.pathname !== '/wechat_schema_test' || !['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('Integration tests require the isolated localhost wechat_schema_test database');
    const config={host:url.hostname,port:Number(url.port || 3306),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),dateStrings:true,decimalNumbers:true};
    const bootstrap=await mysql.createConnection(config);
    await bootstrap.query('DROP DATABASE IF EXISTS wechat_schema_test');
    await bootstrap.query('CREATE DATABASE wechat_schema_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await bootstrap.end();
    pool=mysql.createPool({...config,database:'wechat_schema_test',connectionLimit:5});db=new Database(pool);
    for (const file of ['legacy-schema.sql','002-v1-compatibility.sql']) {
      const ddl=readFileSync(resolve(__dirname,'../database',file),'utf8');
      for (const sql of ddl.replace(/^\s*--.*$/gm,'').split(';').map(sql=>sql.trim()).filter(Boolean)) await db.query(sql);
    }
    const services={db,auth:{bearer:async ()=> (await db.one('SELECT * FROM player WHERE id=1'))!}} as Services;
    router=new ApiRouter();registerV1(router,services);
  });
  afterAll(async () => {await pool?.end();});
  beforeEach(async () => {
    if (!db) return;
    await db.query('DELETE FROM record');await db.query('DELETE FROM manager');await db.query('DELETE FROM operation');await db.query('DELETE FROM device');await db.query('DELETE FROM shop');await db.query('DELETE FROM player');
    await db.insert('player',{id:1,tel:'test-manager'});await db.insert('manager',{player_id:1,type:'staff'});
    await db.insert('player',{id:2,tel:'test-player',recharge:100,points:50});
    await db.insert('shop',{id:1,price:10,rate:80,play_time:60});
    await db.insert('device',{id:1,uuid:'game-device',shop_id:1,version:1});
    await db.insert('operation',{id:1,shop_id:1,pool:0,income:0,turnover:0});
  });
  async function call(method:string,path:string,body:Row={},query:Row={}) {
    const ctx={req:{method,path,protocol:'https',get:()=> 'game.test',ip:'127.0.0.1',headers:{}},res:{status(){return this;},setHeader(){}},body,query,params:{}} as unknown as Context;
    const found=router.match(method,path);expect(found).not.toBeNull();ctx.params=found!.params;return found!.route.handler(ctx) as Promise<any>;
  }
  test('imports all final tables indexes and foreign keys plus the explicit v1 compatibility column', async () => {
    const tables=await db.query('SHOW TABLES');expect(tables).toHaveLength(17);
    expect((await db.columns('device')).find(c=>c.name==='shop_id')).toMatchObject({nullable:true});
    const version=(await db.columns('device')).find(c=>c.name==='version')!;
    expect(version.nullable).toBe(false);expect(Number(version.default)).toBe(0);
    const foreign=await db.query("SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='wechat_schema_test'");
    expect(foreign).toHaveLength(17);
  });
  test('actual MySQL JSON state and transactions preserve charge start finish and award bounds', async () => {
    const ready=await call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1});
    expect(ready.record.game).toMatchObject({points:expect.any(Number),secodes:60});
    await call('POST','/v1/game/start',{}, {uuid:'game-device'});
    const done=await call('POST','/v1/game/finish',{points:999},{uuid:'game-device'});
    expect(done.player).toMatchObject({cost:10,points:50+ready.record.game.points,times:1,role:'player'});
    expect(await db.one('SELECT * FROM record')).toBeNull();
    expect(await db.one('SELECT pool,income,turnover FROM operation WHERE id=1')).toEqual({pool:8-ready.record.game.points,income:2,turnover:10});
  });
  test('MySQL row locks prevent duplicate reservation under concurrent requests', async () => {
    const attempts=await Promise.allSettled([call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1}),call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1})]);
    expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(attempts.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect(await db.one('SELECT cost FROM player WHERE id=2')).toEqual({cost:10});
    expect(await db.query('SELECT * FROM record')).toHaveLength(1);
  });
  test('MySQL insert failure rolls back reservation balance and prize pool', async () => {
    await db.query("CREATE TRIGGER test_reject_record BEFORE INSERT ON record FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional fixture failure'");
    try {
      await expect(call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1})).rejects.toThrow('intentional fixture failure');
      expect(await db.one('SELECT cost FROM player WHERE id=2')).toEqual({cost:0});
      expect(await db.one('SELECT pool,income,turnover FROM operation WHERE id=1')).toEqual({pool:0,income:0,turnover:0});
    } finally {await db.query('DROP TRIGGER test_reject_record');}
  });
});
