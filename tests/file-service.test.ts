import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Context, Row, Services } from '../src/core/contracts';
import { ApiRouter } from '../src/core/router';
import { registerV2 } from '../src/v2';

class FilesDb {
  sqlite = new DatabaseSync(':memory:');
  constructor() {
    this.sqlite.exec(`CREATE TABLE file (id INTEGER PRIMARY KEY, user_id INTEGER, unionid TEXT, key TEXT, unlocked INTEGER DEFAULT 0, price INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE setup (id INTEGER PRIMARY KEY, device_id INTEGER, money REAL);
      CREATE TABLE user (id INTEGER PRIMARY KEY, openid TEXT, unionid TEXT);
      CREATE TABLE file_payment_order (out_trade_no TEXT PRIMARY KEY, user_id INTEGER NOT NULL, file_id INTEGER NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO file VALUES (1,1,'same','one',0,250,'2026-01-01','original'),(2,NULL,'same','legacy',0,NULL,'2026-01-02','original'),(3,2,'same','foreign',0,300,'2026-01-03','original'),(4,NULL,'other','other-legacy',0,0,'2026-01-04','original');`);
  }
  async query(sql:string,params:any[]=[]):Promise<Row[]> {return this.sqlite.prepare(sql).all(...params) as Row[];}
  async one(sql:string,params:any[]=[]) {return (await this.query(sql,params))[0] ?? null;}
  async execute(sql:string,params:any[]=[]) {
    try {const result=this.sqlite.prepare(sql).run(...params);return {affectedRows:Number(result.changes),insertId:Number(result.lastInsertRowid)};}
    catch(error:any) {if([1555,2067].includes(error.errcode))error.code='ER_DUP_ENTRY';throw error;}
  }
  async insert(table:string,data:Row) {
    const columns=(await this.query(`PRAGMA table_info(${table})`)).map(row=>row.name);
    const entries=Object.entries(data).filter(([key])=>columns.includes(key));
    const saved=await this.execute(`INSERT INTO ${table} (${entries.map(([key])=>'`'+key+'`').join(',')}) VALUES (${entries.map(()=>'?').join(',')})`,entries.map(([,value])=>value));
    return (await this.one(`SELECT * FROM ${table} WHERE id=?`,[saved.insertId]))!;
  }
  async update(table:string,id:any,data:Row) {const entries=Object.entries(data);await this.execute(`UPDATE ${table} SET ${entries.map(([key])=>'`'+key+'`=?').join(',')} WHERE id=?`,[...entries.map(([,value])=>value),id]);return (await this.one(`SELECT * FROM ${table} WHERE id=?`,[id]))!;}
}
const user={id:1,openid:'payer',unionid:'same'};
async function fixture() {
  const db=new FilesDb(), records=new Map<string,Row>();
  const redis={find:async(model:string,token:string)=>structuredClone(records.get(model+':'+token) ?? null),save:async(model:string,row:Row)=>{records.set(model+':'+row.token,structuredClone(row));return row;}};
  const s={db,redis,auth:{bearer:async()=>user,requireDevice:()=>{}},integrations:{fileMetadata:async()=>({created_at:'2026-01-05'})}} as unknown as Services;
  const router=new ApiRouter();registerV2(router,s);
  const request=async(path:string,query:Row={},method='GET',body:Row={})=>{
    const found=router.match(method,path);expect(found).not.toBeNull();const headers:Row={};
    const value=await found!.route.handler({body,query,params:found!.params,req:{protocol:'https',get:()=> 'game.test',originalUrl:path,headers:{},method},res:{setHeader:(key:string,value:any)=>{headers[key.toLowerCase()]=value;}}} as unknown as Context);
    return {value:value as any,headers};
  };
  return {db,redis,s,request};
}

describe('current mini program file ownership',()=>{
  it('scopes list/index/view to the current user plus unassigned matching unionid rows',async()=>{
    const f=await fixture();
    const list=await f.request('/v2/files/list',{unionid:'other','per-page':1,page:99,sort:'id'});
    expect(list.value.map((row:Row)=>row.id)).toEqual([2,1]);expect(list.headers).toEqual({});
    expect((await f.request('/v2/files/1')).value).toMatchObject({id:1,price:250});
    expect((await f.request('/v2/files/2')).value.id).toBe(2);
    await expect(f.request('/v2/files/3')).rejects.toMatchObject({status:404,message:'文件不存在或不属于当前账号'});
    await expect(f.request('/v2/files/4')).rejects.toMatchObject({status:404});
    const index=await f.request('/v2/files',{'per-page':1,page:1,sort:'created_at'});
    expect(index.value.map((row:Row)=>row.id)).toEqual([2]);expect(index.headers['x-pagination-total-count']).toBe(2);
    expect((await f.request('/v2/files',{sort:'id'})).value.map((row:Row)=>row.id)).toEqual([1,2]);
  });
  it('preserves missing CRUD actions as explicit 404 responses',async()=>{
    const f=await fixture();
    for(const [method,path] of [['POST','/v2/files'],['PUT','/v2/files/1'],['PATCH','/v2/files/1']])await expect(f.request(path,{},method,{unlocked:1,price:0})).rejects.toMatchObject({status:404});
    expect((await f.db.one('SELECT * FROM file WHERE id=1'))!.unlocked).toBe(0);
  });
});

describe('file payment service',()=>{
  async function service() {const f=await fixture();const module=await import('../src/v2/file-service').catch(()=>({} as any));expect(module.MiniProgramFileService).toBeTypeOf('function');return {...f,files:new module.MiniProgramFileService(f.db),price:module.priceInCents};}
  it('validates integer cents without multiplying units or inventing a historical price',async()=>{
    const f=await service();
    for(const value of [0,250,2147483647,'250','+250',' 250 '])expect(f.price(value)).toBe(Number(value));
    for(const value of [null,true,[],{},-1,1.5,'1.5','01','0x1',2147483648])expect(f.price(value)).toBeNull();
    expect(f.files.prepareOrder(await f.files.findOwned(1,user),user,250,'payer')).toEqual({amount:250,openid:'payer',attach:JSON.stringify({v:1,file_id:1,user_id:1,amount:250})});
    expect(()=>f.files.prepareOrder({id:2,price:null},user)).toThrow('该历史文件尚未确认收费金额，请联系管理员');
    expect(()=>f.files.prepareOrder({id:1,price:0},user)).toThrow('该文件无需重复支付，请刷新文件状态');
    expect(()=>f.files.prepareOrder({id:1,price:250,unlocked:1},user)).toThrow('该文件无需重复支付，请刷新文件状态');
    expect(()=>f.files.prepareOrder({id:1,price:250},user,251)).toThrow('文件金额已更新，请刷新后重试');
    expect(()=>f.files.prepareOrder({id:1,price:250},user,250,'other')).toThrow('付款账号与当前登录账号不一致');
  });
  it('unlocks only an owned exact-price successful provider transaction and preserves timestamps',async()=>{
    const f=await service();await f.db.execute('INSERT INTO file_payment_order VALUES (?,?,?,?,?)',['order01',1,1,250,'2026-01-01 00:00:00']);const order={out_trade_no:'order01',appid:'app',mchid:'merchant',payer:{openid:'payer'},amount:{total:250,currency:'CNY'},attach:JSON.stringify({v:1,file_id:1,user_id:1,amount:250}),trade_state:'NOTPAY'};
    expect(await f.files.confirmPayment(order,user,'app','merchant')).toBe(false);
    for(const patch of [{appid:'other'},{mchid:'other'},{payer:{openid:'other'}},{amount:{total:251,currency:'CNY'}},{amount:{total:250,currency:'USD'}},{attach:JSON.stringify({v:1,file_id:1,user_id:2,amount:250})}])await expect(f.files.confirmPayment({...order,...patch,trade_state:'SUCCESS'},user,'app','merchant')).rejects.toMatchObject({status:403});
    expect((await f.db.one('SELECT unlocked FROM file WHERE id=1'))!.unlocked).toBe(0);
    expect(await f.files.confirmPayment({...order,trade_state:'SUCCESS'},user,'app','merchant')).toBe(true);
    expect(await f.db.one('SELECT unlocked,updated_at FROM file WHERE id=1')).toEqual({unlocked:1,updated_at:'original'});
  });

  it('reserves an immutable order binding and allows retries of the same user file and amount',async()=>{
    const before=Date.now();const f=await service();const file=await f.files.findOwned(1,user);
    const prepared=await f.files.reserveOrder('order01',file,user);
    expect(prepared).toEqual(f.files.prepareOrder(file,user));
    const binding=await f.files.assertOrderOwner('order01',user);
    expect(binding).toMatchObject({out_trade_no:'order01',user_id:1,file_id:1,amount:250});
    expect(binding.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(Date.parse(binding.created_at.replace(' ','T')+'Z')).toBeGreaterThanOrEqual(before-1000);
    expect(Date.parse(binding.created_at.replace(' ','T')+'Z')).toBeLessThanOrEqual(Date.now());
    expect(await f.files.reserveOrder('order01',file,user)).toEqual(prepared);
    expect(await f.db.one('SELECT COUNT(*) AS count FROM file_payment_order')).toEqual({count:1});
    await f.db.insert('file',{id:5,user_id:1,key:'second',price:250});
    await expect(f.files.reserveOrder('order01',await f.files.findOwned(5,user),user)).rejects.toMatchObject({status:409,message:'订单编号已绑定其他文件、账号或金额'});
    const other={id:2,openid:'other',unionid:'same'};
    await expect(f.files.reserveOrder('order01',await f.files.findOwned(3,other),other)).rejects.toMatchObject({status:409});
    await f.db.update('file',1,{price:251});
    await expect(f.files.reserveOrder('order01',await f.files.findOwned(1,user),user)).rejects.toMatchObject({status:409});
    expect(await f.files.assertOrderOwner('order01',user)).toEqual(binding);
  });

  it('uses the unique order key to arbitrate simultaneous identical and conflicting reservations',async()=>{
    const f=await service();const first=await f.files.findOwned(1,user);
    await Promise.all([f.files.reserveOrder('race001',first,user),f.files.reserveOrder('race001',first,user)]);
    expect(await f.db.one('SELECT COUNT(*) AS count FROM file_payment_order')).toEqual({count:1});
    await f.db.insert('file',{id:5,user_id:1,key:'second',price:250});
    const second=await f.files.findOwned(5,user);
    const results=await Promise.allSettled([f.files.reserveOrder('race002',first,user),f.files.reserveOrder('race002',second,user)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const rejected=results.find(result=>result.status==='rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({status:409,message:'订单编号已绑定其他文件、账号或金额'});
    expect(await f.db.one('SELECT COUNT(*) AS count FROM file_payment_order WHERE out_trade_no=?',['race002'])).toEqual({count:1});
  });

  it('rechecks file ownership before reserving and resolves callback users only from local orders',async()=>{
    const f=await service();
    await expect(f.files.reserveOrder('order01',{id:3,price:300},user)).rejects.toMatchObject({status:404});
    await expect(f.files.assertOrderOwner('order01',user)).rejects.toMatchObject({status:403,message:'订单不存在或不属于当前账号'});
    await expect(f.files.findOrderUser('order01')).rejects.toMatchObject({status:403,message:'订单账号不存在'});
    await f.db.insert('user',user);await f.files.reserveOrder('order01',await f.files.findOwned(1,user),user);
    expect(await f.files.findOrderUser('order01')).toEqual(user);
    await expect(f.files.assertOrderOwner('order01',{id:2})).rejects.toMatchObject({status:403});
    await expect(f.files.assertOrderOwner('bad',user)).rejects.toMatchObject({status:400,message:'订单编号无效'});
  });

  it('accepts known unpaid states without optional WeChat payment details and rejects unknown states',async()=>{
    const f=await service();await f.db.execute('INSERT INTO file_payment_order VALUES (?,?,?,?,?)',['order01',1,1,250,'2026-01-01 00:00:00']);
    const order={out_trade_no:'order01',appid:'app',mchid:'merchant'};
    for(const trade_state of ['NOTPAY','CLOSED','REVOKED','USERPAYING','PAYERROR','REFUND'])expect(await f.files.confirmPayment({...order,trade_state},user,'app','merchant')).toBe(false);
    for(const trade_state of [undefined,null,'','UNKNOWN'])await expect(f.files.confirmPayment({...order,trade_state},user,'app','merchant')).rejects.toMatchObject({status:403,message:'订单支付状态无效'});
    await expect(f.files.confirmPayment({...order,trade_state:'NOTPAY',appid:'other'},user,'app','merchant')).rejects.toMatchObject({status:403,message:'订单收款方校验失败'});
    expect((await f.db.one('SELECT unlocked FROM file WHERE id=1'))!.unlocked).toBe(0);
  });

  it('rejects successful provider transactions whose attachment changes the local file or price binding',async()=>{
    const f=await service();await f.files.reserveOrder('order01',await f.files.findOwned(1,user),user);
    await f.db.insert('file',{id:5,user_id:1,key:'second',price:250});
    const order={out_trade_no:'order01',appid:'app',mchid:'merchant',payer:{openid:'payer'},amount:{total:250,currency:'CNY'},trade_state:'SUCCESS'};
    for(const attachment of [{v:1,file_id:5,user_id:1,amount:250},{v:1,file_id:1,user_id:1,amount:251}])await expect(f.files.confirmPayment({...order,attach:JSON.stringify(attachment)},user,'app','merchant')).rejects.toMatchObject({status:403,message:'订单不属于当前文件账号'});
    await expect(f.files.confirmPayment({...order,out_trade_no:'missing',attach:JSON.stringify({v:1,file_id:1,user_id:1,amount:250})},user,'app','merchant')).rejects.toMatchObject({status:403,message:'订单不存在或不属于当前账号'});
    expect((await f.db.one('SELECT unlocked FROM file WHERE id=1'))!.unlocked).toBe(0);
    expect((await f.db.one('SELECT unlocked FROM file WHERE id=5'))!.unlocked).toBe(0);
  });
});

describe('recording file price snapshot',()=>{
  it('records integer cents at creation and retains existing unknown prices on later recordings',async()=>{
    const f=await fixture();await f.db.insert('setup',{device_id:7,money:250});
    await f.redis.save('report',{token:'recording',device_id:7});await f.redis.save('applet',{token:'recording',id:'same',user_id:1});
    await f.request('/v2/server/file',{expand:'file'},'POST',{token:'recording',key:'new-clip'});
    expect((await f.db.one('SELECT * FROM file WHERE key=?',['new-clip']))!.price).toBe(250);
    await f.db.update('setup',1,{money:999});await f.redis.save('applet',{token:'legacy',id:'same',user_id:1});await f.redis.save('report',{token:'legacy',device_id:7});
    await f.request('/v2/server/file',{expand:'file'},'POST',{token:'legacy',key:'legacy'});
    expect((await f.db.one('SELECT price FROM file WHERE key=?',['legacy']))!.price).toBeNull();
  });
  it('uses free defaults when no setup exists and leaves invalid noninteger prices unknown',async()=>{
    const f=await fixture();await f.redis.save('applet',{token:'free',id:'same',user_id:1});
    await f.request('/v2/server/file',{},'POST',{token:'free',key:'free-new'});
    expect((await f.db.one('SELECT price FROM file WHERE key=?',['free-new']))!.price).toBe(0);
    await f.db.insert('setup',{device_id:7,money:2.5});await f.redis.save('report',{token:'invalid',device_id:7});await f.redis.save('applet',{token:'invalid',id:'same',user_id:1});
    await f.request('/v2/server/file',{},'POST',{token:'invalid',key:'invalid-price'});
    expect((await f.db.one('SELECT price FROM file WHERE key=?',['invalid-price']))!.price).toBeNull();
  });
});
