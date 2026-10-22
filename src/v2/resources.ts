import type { Context, Row, Services } from '../core/contracts';
import { ApiError } from '../core/errors';
import { hasDecodedJson, markJsonDecoded } from '../core/json';
import { yiiObject } from '../core/serialization';

type Resource = 'device' | 'setup' | 'file';
const columns: Record<Resource, string[]> = {
  device: ['id', 'version', 'uuid', 'tag', 'created_at', 'updated_at', 'ip'],
  setup: ['id', 'money', 'slogans', 'pictures', 'thumbs', 'title', 'scene_id', 'device_id', 'shots', 'updated_at'],
  file: ['id', 'unionid', 'key', 'type', 'md5', 'size', 'bucket', 'created_at', 'unlocked', 'title', 'user_id', 'price'],
};
const writable: Record<Resource, string[]> = {
  device: columns.device.filter(k => !['id', 'version'].includes(k)),
  setup: columns.setup.filter(k => k !== 'id'),
  file: columns.file.filter(k => k !== 'id'),
};
const jsonColumns = new Set(['slogans', 'pictures', 'thumbs', 'shots']);
const assignedAttributes = new WeakMap<Row, Row>();
export const sqlNow = () => new Intl.DateTimeFormat('sv-SE', { timeZone: process.env.TZ || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
export function csv(value: unknown): string[] { return typeof value === 'string' ? value.split(',').map(v => v.trim()).filter(Boolean) : []; }
function nested(names: string[], key: string): string[] { return names.filter(n => n.startsWith(`${key}.`)).map(n => n.slice(key.length + 1)); }
function rootNames(names: string[]): Set<string> { return new Set(names.map(n => n.split('.')[0])); }
function decode(value: any): any { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } }
export function hydrate(row: Row): Row { return markJsonDecoded(hasDecodedJson(row) ? { ...row } : Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonColumns.has(key) ? decode(value) : value]))); }
export function absoluteLocation(ctx: Context, path: string): string {
  return new URL(path, `${ctx.req.protocol || 'http'}://${ctx.req.get('host') || 'localhost'}`).toString();
}
export function denyAdministration(): never { throw new ApiError(403, '微信登录仅可配置关联设备，不可创建、删除或分配设备'); }
export function bodyDeviceId(value: unknown): number {
  if (!((typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))))) throw new ApiError(422, 'device_id 必须为有效设备编号');
  return Number(value);
}
export async function controlledDevice(s: Services, user: Row, id: any): Promise<Row> {
  const row = await s.db.one('SELECT * FROM device WHERE id IN (SELECT device_id FROM control WHERE user_id = ?) AND id = ?', [user.id, id]);
  if (!row) throw new ApiError(404, '设备不存在或未关联');
  return row;
}
export async function controlledSetup(s: Services, user: Row, id: any): Promise<Row> {
  const row = await s.db.one('SELECT * FROM setup WHERE device_id IN (SELECT device_id FROM control WHERE user_id = ?) AND id = ?', [user.id, id]);
  if (!row) throw new ApiError(404, '设备配置不存在或未关联');
  return hydrate(row);
}
async function publicUser(s: Services, row: Row, fields: string[]): Promise<Row> {
  let role: string;
  if (['15000159790', '15601920021'].includes(row.tel)) role = 'root';
  else role = await s.db.one('SELECT * FROM control WHERE user_id = ?', [row.id]) ? 'manager' : 'user';
  if (row.role !== role) await s.db.execute('UPDATE user SET role = ? WHERE id = ?', [role,row.id]);
  const requested = rootNames(fields);
  const allowed = fields.length && !requested.has('*') ? requested : new Set(['id', 'tel', 'nickname', 'avatar', 'role']);
  return Object.fromEntries(['id', 'tel', 'nickname', 'avatar', 'role'].filter(key => allowed.has(key)).map(key => [key, key === 'role' ? role : row[key] ?? null]));
}
export async function serialize(s: Services, resource: Resource, row: Row, query: Row = {}): Promise<Row> {
  row = hydrate(row);
  const fields = csv(query.fields), expands = csv(query.expand);
  const requested = rootNames(fields);
  const selected = fields.length && !requested.has('*') ? requested : new Set(columns[resource]);
  const output: Row = {};
  for (const key of columns[resource]) if (selected.has(key) && Object.hasOwn(row,key)) output[key] = row[key] ?? null;
  if (resource === 'device') {
    const extra = rootNames(expands);
    if (extra.has('setup')) {
      let setup = await s.db.one('SELECT * FROM setup WHERE device_id = ?', [row.id]);
      if (!setup) setup = await saveResource(s, 'setup', await validate(s, 'setup', { device_id: row.id }));
      output.setup = await serialize(s, 'setup', setup, { fields: nested(fields, 'setup').join(','), expand: nested(expands, 'setup').join(',') });
    }
    if (extra.has('admin')) {
      const controls = await s.db.query('SELECT * FROM control WHERE device_id = ?', [row.id]);
      const users = await Promise.all(controls.map(control => s.db.one('SELECT * FROM user WHERE id = ?', [control.user_id])));
      output.admin = await Promise.all(users.filter((user): user is Row => Boolean(user)).map(user => publicUser(s, user, nested(fields, 'admin'))));
    }
  }
  return output;
}
export async function paginate(s: Services, ctx: Context, resource: Resource, user?: Row, manage = false, options: { where?: string[]; params?: any[]; headers?: boolean } = {}): Promise<Row[]> {
  const where: string[] = [...options.where || []], params: any[] = [...options.params || []];
  if (resource !== 'file') { where.push(`${resource === 'setup' ? 'device_id' : 'id'} IN (SELECT device_id FROM control WHERE user_id = ?)`); params.push(user!.id); }
  // ActiveController's ordinary index does not apply search-model filters.
  if (manage) {
    const filters: Row = typeof ctx.query.DeviceSearch === 'object' && ctx.query.DeviceSearch ? ctx.query.DeviceSearch : {};
    const id = filters.id ?? ctx.query['DeviceSearch[id]'];
    const emptyId = id === undefined || id === null || id === '' || Array.isArray(id) && id.length === 0;
    const validId = emptyId || (typeof id === 'string' || typeof id === 'number') && /^[+-]?\d+$/.test(String(id));
    // DeviceSearch returns its unfiltered provider when validation fails. Version
    // is not safe in that model, and its unused pageSize argument has no effect.
    for (const key of validId ? ['id', 'uuid', 'tag', 'created_at', 'updated_at', 'ip'] : []) {
      const value = filters[key] ?? ctx.query[`DeviceSearch[${key}]`];
      if (value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0) continue;
      const like = ['uuid', 'tag', 'ip'].includes(key);
      where.push(`\`${key}\` ${like ? 'LIKE' : '='} ?`); params.push(like ? `%${String(value).replace(/[\\%_]/g,'\\$&')}%` : value);
    }
  }
  const suffix = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const count = await s.db.one(`SELECT COUNT(*) AS total FROM ${resource}${suffix}`, params);
  const total = Number(count?.total || 0);
  const rawSize = ctx.query['per-page'] ?? 20;
  const pageSize = Math.max(1, Math.min(50, Number.isFinite(Number(rawSize)) ? Math.trunc(Number(rawSize)) : 20));
  const pageCount = Math.ceil(total / pageSize);
  const rawPage = Math.trunc(Number(ctx.query.page || 1));
  const page = Math.max(1, Math.min(Number.isFinite(rawPage) ? rawPage : 1, pageCount || 1));
  const sorts = csv(ctx.query.sort).map(value => ({ key: value.replace(/^-/, ''), direction: value.startsWith('-') ? 'DESC' : 'ASC' })).filter(({ key }) => columns[resource].includes(key)).slice(0, 1);
  const ordering: Record<string, string> = resource === 'file' ? { id: 'DESC' } : {};
  for (const sort of sorts) ordering[sort.key] = sort.direction;
  const order = Object.keys(ordering).length ? ' ORDER BY ' + Object.entries(ordering).map(([key,direction]) => `\`${key}\` ${direction}`).join(', ') : '';
  const rows = await s.db.query(`SELECT * FROM ${resource}${suffix}${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  if (options.headers !== false) {
  for (const [name, value] of Object.entries({ 'X-Pagination-Total-Count': total, 'X-Pagination-Page-Count': pageCount, 'X-Pagination-Current-Page': page, 'X-Pagination-Per-Page': pageSize })) ctx.res.setHeader(name, value);
  const base = new URL(ctx.req.originalUrl || ctx.req.url || '/', `${ctx.req.protocol || 'http'}://${ctx.req.get('host') || 'localhost'}`);
  for (const [key, value] of Object.entries(ctx.query)) if (typeof value === 'string' || typeof value === 'number') base.searchParams.set(key, String(value));
  const link = (target: number, rel: string) => { const url = new URL(base); url.searchParams.set('page', String(target)); return `<${url.toString()}>; rel="${rel}"`; };
  const links = [link(page, 'self')];
  if (pageCount > 0) { links.push(link(1, 'first'), link(pageCount, 'last')); if (page > 1) links.push(link(page - 1, 'prev')); if (page < pageCount) links.push(link(page + 1, 'next')); }
  ctx.res.setHeader('Link', links.join(', '));
  }
  return Promise.all(rows.map(row => serialize(s, resource, row, ctx.query)));
}
function validationFailure(errors: { field: string; message: string }[]): never {
  const error = new ApiError(422, 'Data Validation Failed.', 'Unprocessable Entity');
  (error as any).responseBody = errors;
  throw error;
}
export async function validate(s: Services, resource: Resource, body: Row, current?: Row): Promise<Row> {
  const data = Object.fromEntries(Object.entries(body).filter(([key]) => writable[resource].includes(key)));
  const assigned={...data};
  const errors: { field: string; message: string }[] = [];
  const hasError = (field: string) => errors.some(error => error.field === field);
  const error = (field: string, message: string) => { if (!hasError(field)) errors.push({ field, message }); };
  const label = (field: string): string => ({scene_id:'Scene ID',device_id:'Device ID',user_id:'User ID'}[field] ?? field.charAt(0).toUpperCase()+field.slice(1));
  if (resource === 'file') {
    const key = Object.hasOwn(data, 'key') ? data.key : current?.key;
    if (key === undefined || key === null || typeof key === 'string' && !key.trim() || Array.isArray(key) && key.length === 0) error('key', 'Key cannot be blank.');
  }
  const integers = resource === 'setup' ? ['scene_id', 'device_id'] : resource === 'file' ? ['size', 'unlocked', 'user_id', 'price'] : [];
  for (const field of integers) if (data[field] !== undefined && data[field] !== null && data[field] !== '') {
    if (Array.isArray(data[field]) && data[field].length === 0) data[field] = 0;
    if (!(typeof data[field] === 'number' && Number.isInteger(data[field])) && !(typeof data[field] === 'string' && /^[+-]?\d+$/.test(data[field]))) error(field, `${label(field)} must be an integer.`);
  }
  if (resource === 'file' && !hasError('price') && data.price !== undefined && data.price !== null && data.price !== '' && Number(data.price) < 0) error('price', 'Price must be no less than 0.');
  if (resource === 'setup' && data.money !== undefined && data.money !== null && data.money !== '') {
    if (Array.isArray(data.money) && data.money.length === 0) data.money = 0;
    if (!((typeof data.money === 'number' || typeof data.money === 'string') && /^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/.test(String(data.money)) && Number.isFinite(Number(data.money)))) error('money', 'Money must be a number.');
  }
  const strings = resource === 'device' ? ['uuid', 'tag', 'ip'] : resource === 'setup' ? ['title'] : ['unionid', 'key', 'type', 'md5', 'bucket', 'title'];
  for (const field of strings) if (!hasError(field) && data[field] !== undefined && data[field] !== null) {
    if (typeof data[field] !== 'string') error(field, `${label(field)} must be a string.`);
    else if ([...data[field]].length > 255) error(field, `${label(field)} should contain at most 255 characters.`);
  }
  const unique = resource === 'device' ? ['uuid', 'tag'] : resource === 'file' ? ['key', 'md5'] : [];
  for (const field of unique) if (!hasError(field) && typeof data[field] === 'string' && data[field] !== '') {
    const found = await s.db.one(`SELECT * FROM ${resource} WHERE \`${field}\` = ?`, [data[field]]);
    if (found && String(found.id) !== String(current?.id)) error(field, `${label(field)} "${data[field]}" has already been taken.`);
  }
  if (resource === 'setup' && !hasError('device_id') && data.device_id !== undefined && data.device_id !== null && data.device_id !== '' && !await s.db.one('SELECT * FROM device WHERE id = ?', [data.device_id])) error('device_id', 'Device ID is invalid.');
  if (resource === 'file' && !hasError('user_id') && data.user_id !== undefined && data.user_id !== null && data.user_id !== '' && !await s.db.one('SELECT * FROM user WHERE id = ?', [data.user_id])) error('user_id', 'User ID is invalid.');
  if (errors.length) validationFailure(errors);
  for (const field of [...integers,...resource === 'setup' ? ['money'] : []]) if (data[field] === '') data[field]=null;
  if (resource !== 'file') data.updated_at = sqlNow();
  assignedAttributes.set(data,assigned);
  return data;
}
export async function saveResource(s: Services, resource: Resource, data: Row, current?: Row): Promise<Row> {
  try {
    const saved=current ? await s.db.update(resource, current.id, data) : await s.db.insert(resource, data);
    const response:Row={...current,...assignedAttributes.get(data) ?? data,id:saved.id};
    if (resource !== 'file') response.updated_at=yiiObject('Expression',{expression:'NOW()',params:[]});
    return markJsonDecoded(response);
  }
  catch (error: any) {
    if (['ER_DUP_ENTRY', 'ER_NO_REFERENCED_ROW_2', 'ER_BAD_NULL_ERROR', 'ER_DATA_TOO_LONG', 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD'].includes(error?.code)) validationFailure([{ field: resource, message: error.sqlMessage || error.message }]);
    throw error;
  }
}
