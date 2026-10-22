import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { ApiError } from '../core/errors';
import { equal, sha256 } from './sessions';
import { AdminTokenStore, adminIssuer, authUnavailable, type AdminIdentity, type AdminRecord } from './token-store';

export interface AdminTokenPair { accessToken: string; refreshToken: string; expires: string; refreshExpires: string; }
export class AdminTokens {
  static readonly DOMAIN = 'game-admin';
  static readonly SESSION_SECONDS = 28800;
  static readonly ACCESS_SECONDS = 10800;
  constructor(readonly store: AdminTokenStore, private readonly options: { now?: () => number; issuer?: string; privateKey?: string; publicKey?: string } = {}) {}
  now(): number { return this.options.now?.() ?? Math.floor(Date.now() / 1000); }
  issuer(): string {
    const value = this.options.issuer ?? adminIssuer();
    if (!value || Buffer.byteLength(value) > 255 || /[\x00-\x20\x7f]/.test(value)) throw authUnavailable();
    return value;
  }
  private privateKey(): string {
    try {
      const value = this.options.privateKey ?? readFileSync(process.env.ADMIN_JWT_KEY || '/var/www/.ssh/jwt-key.pem', 'utf8');
      const key = createPrivateKey(value);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
      return value;
    } catch { throw authUnavailable(); }
  }
  private publicKey(): string {
    try {
      const value = this.options.publicKey ?? readFileSync(process.env.ADMIN_JWT_PUB_KEY || '/var/www/.ssh/jwt-key-pub.pem', 'utf8');
      const key = createPublicKey(value);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
      return value;
    } catch { throw authUnavailable(); }
  }
  private invalid(): ApiError { return new ApiError(401, '管理登录凭据无效或已过期，请重新登录'); }
  private accessSid(header: unknown): string {
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)) throw this.invalid();
    const key = this.publicKey(), issuer = this.issuer(), now = this.now();
    try {
      const claims = jwt.verify(header.slice(7), key, { algorithms: ['ES256'], clockTimestamp: now });
      const audience = typeof claims === 'string' ? [] : typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
      if (typeof claims === 'string' || claims.iss !== issuer || claims.identityDomain !== AdminTokens.DOMAIN || claims.tokenUse !== 'access'
        || !Array.isArray(audience) || audience.length !== 1 || audience[0] !== AdminTokens.DOMAIN
        || typeof claims.sid !== 'string' || !/^[a-f0-9]{32}$/.test(claims.sid) || claims.sub !== claims.sid
        || ![claims.iat, claims.nbf, claims.exp].every(Number.isInteger)
        || claims.iat! > now || claims.nbf! > now || claims.exp! <= now || claims.exp! <= claims.iat!
        || claims.exp! - claims.iat! > AdminTokens.ACCESS_SECONDS) throw this.invalid();
      return claims.sid;
    } catch { throw this.invalid(); }
  }
  private refreshSid(refresh: string): string { const match = /^([a-f0-9]{32})\.[a-f0-9]{64}$/.exec(refresh); if (!match) throw this.invalid(); return match[1]; }
  private pack(sid: string, refresh: string, deadline: number): AdminTokenPair {
    const now = this.now(), expires = Math.min(deadline, now + AdminTokens.ACCESS_SECONDS);
    if (deadline <= now) throw this.invalid();
    try {
      const accessToken = jwt.sign({ iss: this.issuer(), aud: AdminTokens.DOMAIN, sub: sid, jti: randomBytes(16).toString('hex'), iat: now, nbf: now, exp: expires, identityDomain: AdminTokens.DOMAIN, tokenUse: 'access', sid }, this.privateKey(), { algorithm: 'ES256' });
      const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', '+00:00');
      return { accessToken, refreshToken: refresh, expires: iso(expires), refreshExpires: iso(deadline) };
    } catch { throw authUnavailable(); }
  }
  async issue(identity: AdminIdentity): Promise<AdminTokenPair> {
    const now = this.now(), sid = randomBytes(16).toString('hex'), deadline = now + AdminTokens.SESSION_SECONDS;
    const refresh = `${sid}.${randomBytes(32).toString('hex')}`, token = this.pack(sid, refresh, deadline);
    await this.store.create(sid, { identity, issuer: this.issuer(), expiresAt: deadline, refreshHash: sha256(refresh) }, now);
    return token;
  }
  private validRecord(record: AdminRecord | null): record is AdminRecord {
    return !!record && record.issuer === this.issuer() && Number.isInteger(record.expiresAt) && record.expiresAt > this.now()
      && !!record.identity && typeof record.identity === 'object' && !Array.isArray(record.identity);
  }
  async identity(header: unknown): Promise<AdminIdentity | null> {
    if (header === undefined || header === null || header === '') return null;
    const record = await this.store.get(this.accessSid(header), this.issuer());
    if (!this.validRecord(record)) throw this.invalid();
    return record.identity;
  }
  async refresh(refresh: string, validate?: (identity: AdminIdentity) => Promise<boolean>): Promise<{ identity: AdminIdentity; token: AdminTokenPair }> {
    const sid = this.refreshSid(refresh), record = await this.store.get(sid, this.issuer());
    if (!this.validRecord(record) || !equal(record.refreshHash, sha256(refresh))) throw this.invalid();
    if (validate && !await validate(record.identity)) throw this.invalid();
    const next = `${sid}.${randomBytes(32).toString('hex')}`, token = this.pack(sid, next, record.expiresAt);
    const rotated = await this.store.rotate(sid, sha256(refresh), sha256(next), this.now(), this.issuer());
    if (!rotated) throw this.invalid();
    return { identity: rotated.identity, token };
  }
  async revoke(header: unknown, refresh?: string): Promise<void> {
    if (header !== undefined && header !== null && header !== '') {
      let sid: string | undefined;
      try { sid = this.accessSid(header); } catch (error) { if (!(error instanceof ApiError) || error.status !== 401 || refresh === undefined) throw error; }
      if (sid) { await this.store.revoke(sid, null, this.issuer()); return; }
    }
    if (refresh) {
      const sid = this.refreshSid(refresh), issuer = this.issuer();
      if (!await this.store.revoke(sid, sha256(refresh), issuer) && await this.store.get(sid, issuer) !== null) throw this.invalid();
    }
  }
}
