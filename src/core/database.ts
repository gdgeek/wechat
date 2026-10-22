import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError } from './errors';
import type { Row } from './contracts';
import { isJsonColumn, markJsonDecoded } from './json';

export interface Column { name: string; type: string; nullable: boolean; default?: unknown; key?: string; }
const transactions = new AsyncLocalStorage<{ pool: Pool; connection: PoolConnection }>();
let savepoint = 0;
export function identifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('Invalid SQL identifier');
  return '`' + name + '`';
}
export class Database {
  private readonly schema = new Map<string, Column[]>();
  readonly pool: Pool;
  constructor(pool?: Pool, private readonly connection?: PoolConnection) {
    this.pool = pool ?? mysql.createPool({
      host: process.env.MYSQL_HOST ?? '127.0.0.1', port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER ?? 'game', password: process.env.MYSQL_PASSWORD ?? '',
      database: process.env.MYSQL_DATABASE ?? 'game', charset: process.env.MYSQL_CHARSET ?? 'utf8mb4',
      timezone: '+08:00', dateStrings: true, decimalNumbers: true,
      connectionLimit: Number(process.env.MYSQL_POOL_SIZE ?? 10), connectTimeout: 5000,
      supportBigNumbers: true, bigNumberStrings: true,
    });
  }
  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [result, fields] = await (this.active() ?? this.pool).query({ sql, typeCast: (field, next) => field.extendedFormat === 'json' || isJsonColumn(field.table, field.name, field.type) ? field.string('utf8') : next() }, params);
    if (Array.isArray(result) && Array.isArray(fields)) for (const row of result as Row[]) {
      for (const field of fields) if ((field.extendedFormat === 'json' || isJsonColumn(field.orgTable || field.table, field.orgName || field.name, field.columnType)) && typeof row[field.name] === 'string') {
        try { row[field.name] = JSON.parse(row[field.name]); } catch { /* Legacy non-JSON text remains unchanged. */ }
      }
      markJsonDecoded(row);
    }
    return result as T[];
  }
  async execute(sql: string, params: unknown[] = []): Promise<{ affectedRows: number; insertId: number }> {
    const [result] = await (this.active() ?? this.pool).query(sql, params);
    return result as { affectedRows: number; insertId: number };
  }
  async one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> { return (await this.query<T>(sql, params))[0] ?? null; }
  async columns(table: string): Promise<Column[]> {
    if (!this.schema.has(table)) {
      const rows = await this.query(`SHOW COLUMNS FROM ${identifier(table)}`);
      this.schema.set(table, rows.map(row => ({ name: row.Field, type: row.Type, nullable: row.Null === 'YES', default: row.Default, key: row.Key })));
    }
    return this.schema.get(table)!;
  }
  private value(table: string, column: Column, value: unknown): unknown {
    if (value !== null && isJsonColumn(table, column.name, column.type)) return JSON.stringify(value);
    return value !== null && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value) ? JSON.stringify(value) : value;
  }
  async insert(table: string, data: Row): Promise<Row> {
    const columns = await this.columns(table);
    const copy = { ...data };
    const entries = Object.entries(copy).filter(([key, value]) => value !== undefined && columns.some(col => col.name === key));
    const names = entries.map(([name]) => identifier(name));
    const placeholders = entries.map(() => '?');
    for (const name of ['created_at', 'updated_at']) if (columns.some(col => col.name === name) && !(name in copy)) { names.push(identifier(name)); placeholders.push('NOW()'); }
    const result = await this.execute(`INSERT INTO ${identifier(table)} (${names.join(',')}) VALUES (${placeholders.join(',')})`, entries.map(([name, value]) => this.value(table, columns.find(col => col.name === name)!, value)));
    const primary = columns.find(col => col.key === 'PRI')?.name ?? 'id';
    return (await this.one(`SELECT * FROM ${identifier(table)} WHERE ${identifier(primary)}=?`, [copy[primary] ?? result.insertId]))!;
  }
  async update(table: string, id: unknown, data: Row): Promise<Row> {
    const columns = await this.columns(table);
    const primary = columns.find(col => col.key === 'PRI')?.name ?? 'id';
    const entries = Object.entries(data).filter(([key, value]) => value !== undefined && key !== primary && columns.some(col => col.name === key));
    const setters = entries.map(([key]) => `${identifier(key)}=?`);
    if (columns.some(col => col.name === 'updated_at') && !('updated_at' in data)) setters.push('`updated_at`=NOW()');
    if (setters.length) await this.execute(`UPDATE ${identifier(table)} SET ${setters.join(',')} WHERE ${identifier(primary)}=?`, [...entries.map(([name, value]) => this.value(table, columns.find(col => col.name === name)!, value)), id]);
    const row = await this.one(`SELECT * FROM ${identifier(table)} WHERE ${identifier(primary)}=?`, [id]);
    if (!row) throw new ApiError(404, 'Object not found');
    return row;
  }
  async delete(table: string, id: unknown): Promise<void> {
    const primary = (await this.columns(table)).find(col => col.key === 'PRI')?.name ?? 'id';
    await this.execute(`DELETE FROM ${identifier(table)} WHERE ${identifier(primary)}=?`, [id]);
  }
  async transaction<T>(operation: (db: Database) => Promise<T>): Promise<T> {
    const active = this.active();
    if (active) {
      const name = `node_tx_${++savepoint}`;
      await active.query(`SAVEPOINT ${name}`);
      try { const result = await operation(new Database(this.pool, active)); await active.query(`RELEASE SAVEPOINT ${name}`); return result; }
      catch (error) { await active.query(`ROLLBACK TO SAVEPOINT ${name}`); await active.query(`RELEASE SAVEPOINT ${name}`); throw error; }
    }
    const connection = await this.pool.getConnection();
    try { await connection.beginTransaction(); const result = await transactions.run({ pool: this.pool, connection }, () => operation(new Database(this.pool, connection))); await connection.commit(); return result; }
    catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  private active(): PoolConnection | undefined { const ambient = transactions.getStore(); return this.connection ?? (ambient?.pool === this.pool ? ambient.connection : undefined); }
  async close(): Promise<void> { await this.pool.end(); }
}
