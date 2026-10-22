import { HttpException } from '@nestjs/common';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { hasDecodedJson } from '../core/json';

export const nowSql = () => new Date().toLocaleString('sv-SE', {timeZone:'Asia/Shanghai'});
export const fail = (status: number, message: string): never => { throw new HttpException(message, status); };
export const needed = (value: any, message: string): any => { if (value === undefined || value === null || value === '' || value === false || value === 0 || value === '0') fail(400,message); return value; };
export const valueOf = (ctx: Context, key: string): any => ctx.params[key] ?? ctx.query[key] ?? ctx.body[key];
const definitions: Record<string, {fields:string[]; required?:string[]; integers?:string[]; numbers?:string[]; strings?:string[]; unique?:string[]; foreign?:Record<string,string>}> = {
  player:{fields:['tel','nickname','openId','avatar','info','recharge','give','cost','times','grade','points','created_at','updated_at'],required:['tel'],integers:['times','grade','points'],numbers:['recharge','cost','give'],strings:['tel','nickname','openId','avatar'],unique:['tel','openId']},
  device:{fields:['shop_id','uuid','tag','ip','created_at','updated_at'],integers:['shop_id'],strings:['uuid','tag','ip'],unique:['uuid','tag'],foreign:{shop_id:'shop'}},
  shop:{fields:['price','play_time','rate','advanced','tag','created_at','updated_at'],integers:['price','play_time','rate','advanced'],strings:['tag']},
  record:{fields:['player_id','device_id','created_at','updated_at','startTime','endTime','game','status'],required:['player_id','device_id'],integers:['player_id','device_id'],strings:['status'],foreign:{device_id:'device',player_id:'player'}},
  award:{fields:['shop_id','price','type'],required:['shop_id'],integers:['shop_id','price'],strings:['type'],foreign:{shop_id:'shop'}},
  gift:{fields:['award_id','created_at','updated_at','info','uuid','tag','picture'],required:['award_id'],integers:['award_id'],strings:['uuid','tag','picture'],unique:['uuid'],foreign:{award_id:'award'}},
};
export class V1Models {
  constructor(readonly db: Database) {}
  async find(table: string, id: any, locked = false): Promise<Row | null> { return this.db.one(`SELECT * FROM \`${table}\` WHERE id = ?${locked ? ' FOR UPDATE' : ''}`, [id]); }
  async where(table: string, field: string, value: any): Promise<Row | null> { return this.db.one(`SELECT * FROM \`${table}\` WHERE \`${field}\` = ? LIMIT 1`,[value]); }
  async require(table: string, id: any, message: string, locked = false): Promise<Row> { return await this.find(table,id,locked) ?? fail(400,message); }
  async manager(playerId: any): Promise<Row | null> { return this.where('manager','player_id',playerId); }
  async operation(shopId: any): Promise<Row> { return await this.where('operation','shop_id',shopId) ?? await this.db.insert('operation',{shop_id:shopId}); }
  async player(row: Row): Promise<Row> { return {...row,role:(await this.manager(row.id))?.type ?? 'player'}; }
  async serialize(table: string, row: Row, expand = '', fields = '', depth = 0): Promise<Row> {
    const result = {...row};
    if (!hasDecodedJson(row) && typeof result.game === 'string') { try { result.game=JSON.parse(result.game); } catch {} }
    if (table === 'device') {
      delete result.created_at; delete result.updated_at;
      result.status = row.shop_id == null ? 'unset' : (await this.where('record','device_id',row.id))?.status ?? 'unused';
    }
    if (table === 'shop') {delete result.created_at;delete result.updated_at;}
    if (table === 'operation') {delete result.id;delete result.shop_id;}
    if (depth < 5) {
      const specs = expand.split(',').filter(Boolean), names=[...new Set(specs.map(x => x.split('.')[0]))];
      for (const name of names) {
        const nested = specs.filter(x => x.startsWith(name+'.')).map(x => x.slice(name.length+1)).join(',');
        const nestedFields = fields.split(',').filter(x => x.startsWith(name+'.')).map(x => x.slice(name.length+1)).join(',');
        let value: any;
        if (table === 'player' && name === 'role') value=(await this.manager(row.id))?.type ?? 'player';
        if (table === 'record' && name === 'player') { const p=await this.find('player',row.player_id); value=p ? await this.player(p) : null; }
        if (table === 'record' && name === 'device') { const d=await this.find('device',row.device_id); value=d ? await this.serialize('device',d,nested,nestedFields,depth+1) : null; }
        if (table === 'shop' && name === 'operation') value=await this.serialize('operation',await this.operation(row.id),nested,nestedFields,depth+1);
        if (table === 'shop' && name === 'awards') {
          const awards=await this.db.query('SELECT * FROM award WHERE shop_id = ?',[row.id]);
          value=await Promise.all(awards.map(award => this.serialize('award',award,nested,nestedFields,depth+1)));
        }
        if (table === 'shop' && name === 'gifts') {
          const gifts=await this.db.query('SELECT gift.* FROM gift INNER JOIN award ON award.id = gift.award_id WHERE award.shop_id = ?',[row.id]);
          value=await Promise.all(gifts.map(g => this.serialize('gift',g,nested,nestedFields,depth+1)));
        }
        if (value !== undefined) result[name]=value;
      }
    }
    const rootFields=fields.split(',').map(field => field.split('.')[0]), rootExpands=expand.split(',').map(field => field.split('.')[0]);
    if (fields && !rootFields.includes('*')) return Object.fromEntries(Object.entries(result).filter(([key]) => rootFields.includes(key) || rootExpands.includes(key)));
    return result;
  }
  async save(table: string, body: Row, previous?: Row): Promise<Row> {
    const spec=definitions[table]; if (!spec) fail(404,'Not Found');
    const data=Object.fromEntries(Object.entries(body).filter(([key]) => spec.fields.includes(key)));
    const awardPrice=data.price === undefined ? previous?.price : data.price;
    if (table === 'award' && (awardPrice === undefined || awardPrice === null || awardPrice === '')) data.price=100;
    const merged={...previous,...data}, errors:Row[]=[];
    const invalid=(field:string,message:string) => errors.push({field,message});
    for (const field of spec.required ?? []) if (merged[field] === undefined || merged[field] === null || merged[field] === '') invalid(field,field+' cannot be blank.');
    for (const field of spec.integers ?? []) if (data[field] !== undefined && data[field] !== null && data[field] !== '') {
      if (!/^[+-]?\d+$/.test(String(data[field])) || !Number.isSafeInteger(Number(data[field]))) invalid(field,field+' must be an integer.'); else data[field]=Number(data[field]);
    }
    for (const field of spec.numbers ?? []) if (data[field] !== undefined && data[field] !== null && data[field] !== '') {
      if (!Number.isFinite(Number(data[field]))) invalid(field,field+' must be a number.'); else data[field]=Number(data[field]);
    }
    for (const field of spec.strings ?? []) if (data[field] != null) {
      if (typeof data[field] !== 'string') invalid(field,field+' must be a string.');
      else if (field !== 'status' && field !== 'type' && [...data[field]].length > 255) invalid(field,field+' should contain at most 255 characters.');
    }
    for (const field of spec.unique ?? []) if (data[field] != null && data[field] !== '') {
      const existing=await this.where(table,field,data[field]); if (existing && existing.id !== previous?.id) invalid(field,field+' has already been taken.');
    }
    for (const [field,target] of Object.entries(spec.foreign ?? {})) if (merged[field] != null && merged[field] !== '' && !await this.find(target,merged[field])) invalid(field,field+' is invalid.');
    if (table === 'award' && merged.shop_id != null && merged.type != null) {
      const existing=await this.db.one('SELECT * FROM award WHERE shop_id = ? AND type = ?',[merged.shop_id,merged.type]);
      if (existing && existing.id !== previous?.id) invalid('type','The combination of shop_id and type has already been taken.');
    }
    if (errors.length) throw new HttpException(errors,422);
    if (table === 'device' && !previous) data.version=1;
    // Yii TimestampBehavior writes timestamps regardless of incoming values.
    if (['player','device','shop','record','gift'].includes(table)) {data.updated_at=nowSql();if (!previous) data.created_at=nowSql();}
    return previous ? this.db.update(table,previous.id,data) : this.db.insert(table,data);
  }
  async list(table:string, ctx:Context):Promise<Row[]> {
    const conditions:string[]=[], args:any[]=[];
    const filter=table === 'award' ? 'shop_id' : table === 'gift' ? 'award_id' : null;
    if (filter && ctx.query[filter] != null) {conditions.push('`'+filter+'` = ?');args.push(ctx.query[filter]);}
    const where=conditions.length ? ' WHERE '+conditions.join(' AND ') : '';
    const total=Number((await this.db.one(`SELECT COUNT(*) AS total FROM \`${table}\`${where}`,args))?.total ?? 0);
    const requestedSize=Number(ctx.query['per-page'] ?? 20);
    const size=Number.isFinite(requestedSize) ? Math.max(1,Math.min(50,Math.floor(requestedSize))) : 20;
    const pageCount=Math.ceil(total/size), requestedPage=Number(ctx.query.page ?? 1);
    const page=Math.max(1,Math.min(Math.max(1,pageCount),Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1));
    let sort='';
    if (ctx.query.sort) {
      const allowed=['id',...definitions[table].fields];
      const clauses=String(ctx.query.sort).split(',').filter(Boolean).flatMap(field => {
        const desc=field.startsWith('-'), name=desc ? field.slice(1) : field;
        return allowed.includes(name) ? ['`'+name+'` '+(desc?'DESC':'ASC')] : [];
      });
      if (clauses.length) sort=' ORDER BY '+clauses.join(',');
    }
    ctx.res.setHeader('X-Pagination-Total-Count',String(total));ctx.res.setHeader('X-Pagination-Page-Count',String(pageCount));
    ctx.res.setHeader('X-Pagination-Current-Page',String(page));ctx.res.setHeader('X-Pagination-Per-Page',String(size));
    const pageLink=(target:number) => {
      const url=new URL(ctx.req.originalUrl ?? '/v1/'+table,ctx.req.protocol+'://'+(ctx.req.get('host') ?? 'localhost'));
      for (const [key,value] of Object.entries(ctx.query)) url.searchParams.set(key,String(value));
      url.searchParams.set('page',String(target));
      return url.toString();
    };
    const links=[`<${pageLink(page)}>; rel=self`,`<${pageLink(1)}>; rel=first`,`<${pageLink(Math.max(1,pageCount))}>; rel=last`];
    if (page>1) links.push(`<${pageLink(page-1)}>; rel=prev`);
    if (page<pageCount) links.push(`<${pageLink(page+1)}>; rel=next`);
    ctx.res.setHeader('Link',links.join(', '));
    const rows=await this.db.query(`SELECT * FROM \`${table}\`${where}${sort} LIMIT ? OFFSET ?`,[...args,size,(page-1)*size]);
    return Promise.all(rows.map(row => this.serialize(table,row,String(ctx.query.expand ?? ''),String(ctx.query.fields ?? ''))));
  }
}
