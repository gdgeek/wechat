import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { ApiError } from '../core/errors';
import { sha256 } from './sessions';

export interface AdminIdentity { source: 'password' | 'wechat'; username: string; credentialFingerprint?: string; wechatUserId?: number; }
export interface AdminRecord { identity: AdminIdentity; issuer: string; expiresAt: number; refreshHash: string; }
export interface AuthRedis { command(args: string[]): Promise<any>; }
export const authUnavailable = () => new ApiError(503, '管理认证服务暂时不可用，请稍后重试');
export const adminIssuer = () => process.env.ADMIN_AUTH_ISSUER || process.env.ADMIN_SCAN_LOGIN_ORIGIN || 'https://checkin.voxel.cn';

/** Uses the exact Yii AdminTokenStore keys, records and atomic Lua operations. */
export class AdminTokenStore {
  private readonly locks = new AsyncLocalStorage<Map<string, string>>();
  constructor(private readonly redis: AuthRedis, private readonly options: { ownerLockSeconds?: number; ownerWaitMilliseconds?: number } = {}) {}
  private async command(args: (string | number)[]): Promise<any> {
    try { return await this.redis.command(args.map(String)); } catch { throw authUnavailable(); }
  }
  private sidKey(sid: string, issuer = adminIssuer()): string {
    if (!/^[a-f0-9]{32}$/.test(sid)) throw authUnavailable();
    return `game:admin:auth:issuer:${sha256(issuer)}:sid:${sid}`;
  }
  private decode(value: unknown): AdminRecord {
    try {
      const record = JSON.parse(String(value));
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error();
      return record;
    } catch { throw authUnavailable(); }
  }
  async create(sid: string, record: AdminRecord, now: number): Promise<void> {
    const result = await this.command(['SET', this.sidKey(sid, record.issuer), JSON.stringify(record), 'EX', Math.max(1, record.expiresAt - now), 'NX']);
    if (result !== true && result !== 'OK') throw authUnavailable();
  }
  async get(sid: string, issuer = adminIssuer()): Promise<AdminRecord | null> {
    const value = await this.command(['GET', this.sidKey(sid, issuer)]);
    return value === null || value === false ? null : this.decode(value);
  }
  async rotate(sid: string, expected: string, next: string, now: number, issuer = adminIssuer()): Promise<AdminRecord | null> {
    const script = `local raw=redis.call('GET',KEYS[1])
if not raw then return false end
local row=cjson.decode(raw)
if row.expiresAt<=tonumber(ARGV[3]) or row.refreshHash~=ARGV[1] then return false end
row.refreshHash=ARGV[2]
local result=cjson.encode(row)
redis.call('SET',KEYS[1],result,'EX',math.max(1,row.expiresAt-tonumber(ARGV[3])))
return result`;
    const value = await this.command(['EVAL', script, 1, this.sidKey(sid, issuer), expected, next, now]);
    return value === null || value === false ? null : this.decode(value);
  }
  async revoke(sid: string, expected: string | null = null, issuer = adminIssuer()): Promise<boolean> {
    if (expected === null) return Number(await this.command(['DEL', this.sidKey(sid, issuer)])) > 0;
    const script = `local raw=redis.call('GET',KEYS[1])
if not raw then return 0 end
local row=cjson.decode(raw)
if row.refreshHash~=ARGV[1] then return 0 end
return redis.call('DEL',KEYS[1])`;
    return Number(await this.command(['EVAL', script, 1, this.sidKey(sid, issuer), expected])) > 0;
  }
  private attemptKey(ip: string, issuer: string): string { return `game:admin:auth:issuer:${sha256(issuer)}:password-attempts:${sha256(ip)}`; }
  async reservePasswordAttempt(ip: string, limit: number, windowSeconds: number, issuer = adminIssuer()): Promise<{ allowed: boolean; attempts: number; retryAfter: number }> {
    const script = `local count=tonumber(redis.call('GET',KEYS[1]) or '0')
local ttl=redis.call('TTL',KEYS[1])
if count>=tonumber(ARGV[1]) then return {0,count,math.max(1,ttl)} end
count=redis.call('INCR',KEYS[1])
if count==1 then redis.call('EXPIRE',KEYS[1],tonumber(ARGV[2])); ttl=tonumber(ARGV[2]) else ttl=redis.call('TTL',KEYS[1]) end
return {1,count,math.max(1,ttl)}`;
    const value = await this.command(['EVAL', script, 1, this.attemptKey(ip, issuer), limit, windowSeconds]);
    if (!Array.isArray(value) || value.length !== 3) throw authUnavailable();
    return { allowed: Number(value[0]) === 1, attempts: Number(value[1]), retryAfter: Number(value[2]) };
  }
  async clearPasswordAttempts(ip: string, issuer = adminIssuer()): Promise<void> { await this.command(['DEL', this.attemptKey(ip, issuer)]); }
  async withOwnerLock<T>(ownerHash: string, callback: () => Promise<T>): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(ownerHash)) throw authUnavailable();
    const key = `game:admin:auth:owner-lock:${ownerHash}`, owner = randomBytes(16).toString('hex');
    const deadline = Date.now() + (this.options.ownerWaitMilliseconds ?? 5000);
    const duration = (this.options.ownerLockSeconds ?? 120) * 1000;
    for (;;) {
      const result = await this.command(['SET', key, owner, 'NX', 'PX', duration]);
      if (result === true || result === 'OK') break;
      if (Date.now() >= deadline) throw authUnavailable();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const held = new Map(this.locks.getStore()); held.set(ownerHash, owner);
    try { return await this.locks.run(held, callback); }
    finally { await this.command(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, key, owner]); }
  }
  async assertOwnerLock(ownerHash: string): Promise<void> {
    const owner = this.locks.getStore()?.get(ownerHash);
    if (!owner) throw authUnavailable();
    const script = "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('PEXPIRE',KEYS[1],ARGV[2]); return 1 else return 0 end";
    if (Number(await this.command(['EVAL', script, 1, `game:admin:auth:owner-lock:${ownerHash}`, owner, (this.options.ownerLockSeconds ?? 120) * 1000])) !== 1) throw authUnavailable();
  }
}
