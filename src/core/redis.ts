import { createHash } from 'node:crypto';
import { createClient } from 'redis';
import type { Row } from './contracts';

export interface RedisConnectionOptions { host?: string; port?: number; database?: number; password?: string; url?: string; timeout?: number; }
export function adminRedisOptions(env: NodeJS.ProcessEnv = process.env): RedisConnectionOptions {
  const dedicated = ['HOST', 'PORT', 'DB', 'PASSWORD'].some(name => !!env[`ADMIN_AUTH_REDIS_${name}`]);
  return { host: env.ADMIN_AUTH_REDIS_HOST || env.REDIS_HOST || '127.0.0.1',
    port: Number(env.ADMIN_AUTH_REDIS_PORT || env.REDIS_PORT || 6379),
    database: Number(env.ADMIN_AUTH_REDIS_DB || env.REDIS_DB || 0),
    password: env.ADMIN_AUTH_REDIS_PASSWORD || env.REDIS_PASSWORD || undefined,
    url: dedicated ? undefined : env.REDIS_URL, timeout: 1500 };
}

export function buildRedisKey(value: unknown): string {
  const key = String(value);
  return /^[-+]?\d+(?:\.\d+)?$/.test(key) || /^[a-zA-Z0-9]{1,32}$/.test(key) ? key : createHash('md5').update(key).digest('hex');
}
export class LegacyRedis {
  private readonly client;
  private connecting?: Promise<unknown>;
  constructor(private readonly options?: RedisConnectionOptions) {
    const config = options ?? { url: process.env.REDIS_URL, host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT ?? 6379), database: Number(process.env.REDIS_DB ?? 0), password: process.env.REDIS_PASSWORD || undefined };
    this.client = createClient({ url: config.url, socket: { host: config.host ?? '127.0.0.1', port: config.port ?? 6379, connectTimeout: config.timeout ?? 3000, reconnectStrategy: false }, database: config.database ?? 0, password: config.password });
    this.client.on('error', () => { /* Request errors are sanitized at the HTTP boundary. */ });
  }
  async connect(): Promise<void> {
    if (this.client.isReady) return;
    this.connecting ??= this.deadline(this.client.connect(), this.options?.timeout ?? 3000).finally(() => { this.connecting = undefined; });
    await this.connecting;
  }
  private async deadline<T>(operation: Promise<T>, timeout: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Redis operation timed out'));
          // node-redis removes AbortSignal listeners after writing a command.
          // Close the stalled socket to reject queued reads and permit reconnection.
          if (this.client.isOpen) this.client.destroy();
        }, timeout);
      })]);
    } finally { clearTimeout(timer!); }
  }
  async command(args: string[], timeout = this.options?.timeout): Promise<any> {
    await this.connect();
    const operation = this.client.sendCommand(args);
    return timeout ? this.deadline(operation, timeout) : operation;
  }
  async ping(): Promise<string> { return this.command(['PING'], 3000); }
  async find(model: string, pk: unknown): Promise<Row | null> {
    const values = await this.command(['HGETALL', `${model}:a:${buildRedisKey(pk)}`]) as string[];
    if (!values.length) return null;
    const row: Row = {};
    for (let i = 0; i < values.length; i += 2) row[values[i]] = values[i + 1];
    return row;
  }
  async all(model: string): Promise<Row[]> {
    const pks = await this.command(['LRANGE', model, '0', '-1']) as string[];
    const rows = await Promise.all(pks.map(pk => this.find(model, pk)));
    return rows.filter((row): row is Row => row !== null);
  }
  async save(model: string, row: Row): Promise<Row> {
    const primary = row.token !== undefined ? 'token' : 'id';
    const pk = row[primary] ?? await this.command(['INCR', `${model}:s:${primary}`]);
    row = { ...row, [primary]: pk };
    const key = buildRedisKey(pk);
    const attributes = Object.entries(row).filter(([, value]) => value !== null && value !== undefined).flatMap(([name, value]) => [name, typeof value === 'object' ? JSON.stringify(value) : typeof value === 'boolean' ? String(Number(value)) : String(value)]);
    const script = "if redis.call('EXISTS',KEYS[1])==0 then redis.call('RPUSH',KEYS[2],ARGV[1]) end; for i=2,#ARGV,2 do redis.call('HSET',KEYS[1],ARGV[i],ARGV[i+1]) end; return 1";
    await this.command(['EVAL', script, '2', `${model}:a:${key}`, model, key, ...attributes]);
    const nulls = Object.entries(row).filter(([, value]) => value === null).map(([name]) => name);
    if (nulls.length) await this.command(['HDEL', `${model}:a:${key}`, ...nulls]);
    return row;
  }
  async remove(model: string, pk: unknown): Promise<void> {
    const key = buildRedisKey(pk);
    await this.command(['EVAL', "redis.call('LREM',KEYS[1],0,ARGV[1]); return redis.call('DEL',KEYS[2])", '2', model, `${model}:a:${key}`, key]);
  }
  async close(): Promise<void> { if (this.client.isOpen) await this.client.quit(); }
}
