import { createHash, randomInt } from 'node:crypto';
import { unescape } from 'node:querystring';
import type { ApiRouter } from '../core/router';
import type { Context, Row, Services } from '../core/contracts';
import { V1Models, fail, needed, nowSql, phpTruthy, valueOf } from './models';
import { recordRequest, readRequest } from '../core/diagnostics';
import { ApiError } from '../core/errors';

const result=(message='success', data:Row={}) => ({success:true,message,...data});
const sec=() => String(Math.floor(Date.now()/1000));
// PHP's urldecode runs after the framework has already decoded the query string.
const deviceUuid=(c:Context) => unescape(String(c.query.uuid ?? '').replace(/\+/g,' '));
const redisAttributes:Record<string,string[]>={
  checkin:['token','openid','unionid','status','data','created_at','updated_at'],
  report:['token','device','status','data','setup','created_at','updated_at'],
  recode_file:['token','key','created_at','updated_at','dbid'],
};
function redisRow(model:string,row:Row|null):Row|null {
  if (!row) return null;
  const value=Object.fromEntries(redisAttributes[model].map(key => [key,row[key] ?? null]));
  if (model === 'report' && row.action !== undefined) value.action=row.action;
  return value;
}
export function registerV1(router: ApiRouter, s: Services): void {
  const models=new V1Models(s.db);
  const record=(c:Context,action:string) => recordRequest(s,c,action);
  const bearer=(c:Context) => s.auth.bearer(c,'v1-player');
  const issuer=(c:Context) => c.req.protocol+'://'+c.req.get('host');
  const manager=async(c:Context) => {const user=await bearer(c);if (!await models.manager(user.id)) fail(400,'Not Manager');return user;};
  const add=(method:string|string[],path:string,handler:(c:Context)=>any) => router.add(method,'/v1/'+path,handler);
  const serialize=(table:string,row:Row,c:Context) => models.serialize(table,row,String(c.query.expand ?? ''),String(c.query.fields ?? ''));
  const rest=(path:string,table:string,authenticated=true) => {
    const guard=async(c:Context) => {if (authenticated) await bearer(c);};
    add(['GET','HEAD'],path,async c => {await guard(c);return models.list(table,c);});
    add(['GET','HEAD'],path+'/:id',async c => {await guard(c);const row=await models.find(table,c.params.id);if (!row) fail(404,'Object not found: '+c.params.id);return serialize(table,row!,c);});
    add('POST',path,async c => {await guard(c);const row=await models.save(table,c.body,undefined,undefined,true);c.res.status(201);c.res.setHeader('Location',issuer(c)+'/v1/'+path+'/'+row.id);return serialize(table,row,c);});
    add(['PUT','PATCH'],path+'/:id',async c => {await guard(c);const row=await models.find(table,c.params.id);if (!row) fail(404,'Object not found: '+c.params.id);return serialize(table,await models.save(table,c.body,row!,undefined,true),c);});
    add('DELETE',path+'/:id',async c => {await guard(c);if (!await models.find(table,c.params.id)) fail(404,'Object not found: '+c.params.id);await s.db.delete(table,c.params.id);c.res.status(204);return null;});
    add('OPTIONS',path,c => {c.res.setHeader('Allow','GET, POST, HEAD, OPTIONS');return null;});
    add('OPTIONS',path+'/:id',c => {c.res.setHeader('Allow','GET, PUT, PATCH, DELETE, HEAD, OPTIONS');return null;});
  };

  add('GET','common/test',() => '1123');
  add('POST','common/refresh-token',async c => result('refresh success',{token:await s.auth.refresh(String(c.body.refreshToken ?? ''),'v1-player',issuer(c))}));
  add('POST','common/sign-in',async c => {
    s.auth.playerFingerprint(c);await record(c,'sign-in');
    const row=await models.where('player','openId',c.body.openId ?? null);
    if (!row) return {success:false,player:null,message:'no signup'};
    return result('success',{player:await models.player(row),token:await s.auth.issue(row,'v1-player',issuer(c))});
  });
  add('POST','common/sign-up',async c => {
    s.auth.playerFingerprint(c);await record(c,'sign-up');needed(c.body.tel,'No Tel');
    let row=await models.where('player','openId',c.body.openId ?? null);const existed=Boolean(row);
    if (!row) row=await models.save('player',{tel:c.body.tel,openId:c.body.openId},undefined,'Invalid parameters');
    return result(existed?'already signup':'success',{player:await models.player(row),token:await s.auth.issue(row,'v1-player',issuer(c))});
  });
  add('GET','web/async-routes',async c => {await bearer(c);return {success:true,data:[]};});
  add('GET','helper/test',async c => {await record(c,'test');return null;});
  add('GET','helper/print',() => readRequest(s));

  add('GET','system/player-info',async c => {await manager(c);const row=await models.require('player',valueOf(c,'targetId'),'No Player');return result('success',{target:await models.player(row)});});
  add('GET','system/reset-shop',async c => {
    await bearer(c);const op=await models.where('operation','shop_id',valueOf(c,'shopId'));if (!op) fail(400,'No Operation');
    return result('success',{operation:await models.serialize('operation',await s.db.update('operation',op!.id,{pool:0,turnover:0,income:0}))});
  });
  // The source give action only validates money and saves the unchanged target.
  add('POST','system/give',async c => {
    const user=await manager(c);const target=await models.require('player',c.body.targetId,'No Player');needed(c.body.money,'No Money');
    const saved=await models.save('player',{},target,undefined,true);return result('success',{user,player:saved});
  });
  add('POST','system/deduct-points',async c => {
    await manager(c);const points=Number(needed(c.body.points,'No Points'));
    if (!Number.isSafeInteger(points)) fail(400,'Save Error');
    return s.db.transaction(async db => {
      const m=new V1Models(db), player=await m.require('player',c.body.targetId,'No Player',true);
      if (points>Number(player.points)) fail(400,'Not Enough Points');
      const saved=await m.save('player',{points:Number(player.points)-points},player,undefined,true);
      return result('success',{player:saved});
    });
  });
  add('GET','system/ready-game',async c => {
    await manager(c);
    return s.db.transaction(async db => {
      const m=new V1Models(db);
      const player=await m.require('player',valueOf(c,'targetId'),'No Player',true);
      const device=await m.require('device',valueOf(c,'deviceId'),'No Device',true);
      const existing=await db.one('SELECT * FROM record WHERE player_id = ? AND device_id = ?',[player.id,device.id]);
      if (existing) fail(400,'Already Running');
      const shop=await m.require('shop',device.shop_id,'No Shop',true);
      const cost=Number(player.cost ?? 0)+Number(shop.price ?? 0);
      if (cost>Number(player.recharge ?? 0)+Number(player.give ?? 0)) fail(400,'Not Enough Money');
      const operation=await m.operation(shop.id);
      const price=Number(shop.price ?? 0), back=price*Number(shop.rate ?? 0)/100;
      const pool=Number(operation.pool ?? 0)+back;
      const lower=Math.floor(pool/2), upper=Math.trunc(pool);
      if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || upper<lower) fail(400,'Invalid parameters');
      const restore=randomInt(lower,upper+1);
      const info={price,old_turnover:operation.turnover,old_pool:operation.pool};
      const balances={pool:pool-restore,turnover:Number(operation.turnover ?? 0)+price,income:Number(operation.income ?? 0)+price-back};
      // Operation's Yii integer validators reject fractional prize-pool and
      // income balances before the reservation can charge the player.
      if (Object.values(balances).some(value=>!Number.isSafeInteger(value))) fail(400,'Invalid parameters[]');
      await db.update('operation',operation.id,balances);
      const game={secodes:shop.play_time,points:restore};
      const row=await m.save('record',{player_id:player.id,device_id:device.id,game});
      await db.update('player',player.id,{cost});
      await m.save('device',{},device);await m.save('shop',{},shop);
      return result('success',{info,record:await m.serialize('record',row,'player,device')});
    });
  });
  add('POST','system/close-record',async c => {
    await manager(c);
    return s.db.transaction(async db => {
      const m=new V1Models(db), row=await m.require('record',c.body.recordId,'No Record:'+c.body.recordId,true);
      const device=await m.require('device',row.device_id,'No Device',true);
      const shop=await m.require('shop',device.shop_id,'No Shop',true), player=await m.require('player',row.player_id,'No Player',true);
      const operation=await m.operation(shop.id), game=(await m.serialize('record',row)).game;
      const price=Number(shop.price ?? 0), back=price*Number(shop.rate ?? 0)/100;
      const savedPlayer=await m.save('player',{cost:Number(player.cost ?? 0)-price},player,undefined,true);
      const savedOp=await db.update('operation',operation.id,{pool:Number(operation.pool ?? 0)+Number(game?.points ?? 0)-back,income:Number(operation.income ?? 0)-(price-back),turnover:Number(operation.turnover ?? 0)-price});
      await db.delete('record',row.id);
      return result('success',{player:savedPlayer,operation:await m.serialize('operation',savedOp)});
    });
  });

  const getDevice=async(c:Context,m:V1Models) => {
    const uuid=deviceUuid(c);let device=await m.where('device','uuid',uuid);
    const body={uuid,ip:c.req.ip ?? ''};
    device=await m.save('device',body,device ?? undefined,'Invalid device:');return device;
  };
  add(['GET','POST'],'game/device',async c => {
    const existing=await models.where('device','uuid',deviceUuid(c));
    const device=existing ?? await getDevice(c,models);
    return result(existing?'old device':'new device',{device:await models.serialize('device',device)});
  });
  add(['GET','POST'],'game/ready',async c => {
    const device=await getDevice(c,models), row=await models.where('record','device_id',device.id);
    if (!row) return {message:'No Ready',success:false};
    const serialized=await models.serialize('record',row);
    return result('Ready to play',{game:serialized.game,record:serialized});
  });
  for (const action of ['start','restart']) add(['GET','POST'],'game/'+action,async c => {
    return s.db.transaction(async db => {
      const m=new V1Models(db), device=await getDevice(c,m), found=await db.one('SELECT * FROM record WHERE device_id = ? LIMIT 1 FOR UPDATE',[device.id]);
      if (!found) fail(400,'No record');const row=found!;
      if (action === 'start' && row.status === 'running') fail(400,'Game is running');
      const saved=await m.save('record',{status:action === 'start'?'running':'ready'},row,'Invalid record');
      return result(action === 'start'?'Game start':'Game restart',action === 'start'?{game:(await m.serialize('record',saved)).game}:{});
    });
  });
  add(['GET','POST'],'game/finish',async c => {
    return s.db.transaction(async db => {
      const m=new V1Models(db), device=await getDevice(c,m), found=await db.one('SELECT * FROM record WHERE device_id = ? LIMIT 1 FOR UPDATE',[device.id]);
      if (!found) fail(400,'No record');const row=found!;
      if (row.status !== 'running') fail(400,'Game is not running');
      const supplied=Number(needed(c.body.points,'points is required'));
      if (!Number.isFinite(supplied)) fail(400,'Invalid points');
      const player=await m.require('player',row.player_id,'No Player',true), shop=await m.require('shop',device.shop_id,'No Shop',true), op=await m.operation(shop.id);
      const game=(await m.serialize('record',row)).game, budget=Number(game?.points ?? 0), points=Math.max(0,Math.min(supplied,budget));
      const saved=await db.update('player',player.id,{points:Number(player.points ?? 0)+points,times:Number(player.times ?? 0)+1});
      await db.update('operation',op.id,{pool:Number(op.pool ?? 0)+budget-points});await db.delete('record',row.id);
      return result('Game over',{player:await m.player(saved)});
    });
  });

  const state=async(token:string) => ({checkin:redisRow('checkin',await s.redis.find('checkin',token)),report:redisRow('report',await s.redis.find('report',token)),file:redisRow('recode_file',await s.redis.find('recode_file',token))});
  const save=async(model:string,row:Row) => {await s.redis.save(model,row);return redisRow(model,row)!;};
  const matchOwner=(row:Row|null,openid:any) => row && String(row.openid ?? '') === String(openid);
  add('GET','checkin/status',async c => {
    const token=String(needed(c.query.token,'token is required')), current=await state(token);
    return current.checkin ? result('already checkin',{data:current}) : {success:false,message:'not checkin'};
  });
  add('POST','checkin/ready',async c => {
    const token=String(needed(c.body.token,'token is required')), openid=String(needed(c.body.openid,'openid is required'));
    const found=await s.redis.find('checkin',token);
    if (matchOwner(found,openid)) return result('already checkin',{data:redisRow('checkin',found)});
    const row={...found,token,openid,status:'ready'};
    return result('success',{data:await save('checkin',row)});
  });
  for (const status of ['ready','linked']) add('POST','checkin/status-'+status,async c => {
    const token=String(needed(c.body.token,'token is required')), openid=String(needed(c.body.openid,'openid is required'));
    let row=await s.redis.find('checkin',token);
    if (!matchOwner(row,openid)) row={token,openid,created_at:sec()};
    if (row!.status !== status) row=await save('checkin',{...row,status,updated_at:sec()});
    const file=await s.redis.find('recode_file',token);
    return result('success',{data:{checkin:redisRow('checkin',row),file:matchOwner(file,openid)?redisRow('recode_file',file):null}});
  });
  add('POST','checkin/status-over',async c => {
    const token=String(needed(c.body.token,'token is required')), openid=needed(c.body.openid,'openid is required');
    if (!matchOwner(await s.redis.find('checkin',token),openid)) return {success:false,message:'not checkin'};
    await s.redis.remove('checkin',token);return result();
  });
  add('DELETE','checkin/close',async c => {
    const openid=needed(c.query.openid,'openid is required'), found=(await s.redis.all('checkin')).find(row => matchOwner(row,openid));
    if (found) {await s.redis.remove('checkin',found.token);return result();}return result('not checkin');
  });
  add('POST','checkin/upload',async c => {
    const token=String(needed(c.body.token,'token is required')), key=needed(c.body.key,'key is required');
    if (!await s.redis.find('checkin',token)) fail(400,'checkin not found');
    return result('file upload success',{data:await save('recode_file',{...await s.redis.find('recode_file',token),token,key,created_at:sec()})});
  });
  add('GET','checkin/files',async c => {
    const openid=needed(c.query.openid,'openid is required'), files=(await s.redis.all('recode_file')).filter(row => matchOwner(row,openid));
    return files.length ? result('files found',{data:files}) : {success:false,message:'no files found',data:[]};
  });
  add('POST','checkin/report',async c => {
    const token=String(needed(c.body.token,'token is required')), action=needed(c.body.action,'action is required'), device=needed(c.body.device,'device is required');
    const existing=await s.redis.find('report',token);
    return result('success',{data:await save('report',{...(existing ?? {token,device}),action})});
  });
  add('GET','local/test',() => readRequest(s));
  add('GET','local/log',async c => {
    const token=valueOf(c,'token');
    if (token === undefined || token === null) throw new ApiError(400,'Missing required parameters: token');
    return result('success',{data:await state(String(token))});
  });
  add(['GET','POST'],'local/refresh',async c => {
    await record(c,'refresh');
    const token=String(needed(c.body.token,'token is required')), time=needed(c.query.time,'time and hash are required'), hash=needed(c.query.hash,'time and hash are required');
    if (!/^[A-Z][0-9a-f]{32}$/i.test(token)) fail(400,'token format error');
    const supplied=['device','openid','key'].filter(key => phpTruthy(c.body[key]));
    if (supplied.length !== 1) fail(400,'Exactly one of device, openid, or key must be provided');
    const param=c.body[supplied[0]];
    if (createHash('md5').update(token+time+param+'buj1aban.c0m').digest('hex') !== hash) fail(400,'hash error');
    if (supplied[0] === 'device' || supplied[0] === 'openid') {
      const model=supplied[0] === 'device'?'report':'checkin', property=supplied[0];
      const existing=await s.redis.find(model,token), row=existing ?? {token,[property]:param,created_at:sec()};
      for (const field of ['status','data']) if (phpTruthy(c.body[field])) row[field]=c.body[field];
      row.updated_at=sec();await save(model,row);
    } else {
      const checkin=await s.redis.find('checkin',token);
      const previous=await s.redis.find('recode_file',token);
      const file=await models.where('file','key',param) ?? await s.db.insert('file',{key:param,unionid:checkin?.unionid ?? null,created_at:nowSql()});
      await save('recode_file',{...(previous ?? {token,key:param,created_at:sec()}),updated_at:sec(),dbid:file.id});
    }
    return result('success',{data:await state(token)});
  });

  // Static routes are registered first so they win over the inherited :id routes.
  for (const table of ['device','shop','player','record','award','gift']) rest(table,table);
  // DeviceFingerprintAuth in the source returns true unconditionally.
  rest('game','device',false);rest('helper','player',false);
}
