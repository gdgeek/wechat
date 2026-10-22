import { createHash, createSecretKey, timingSafeEqual, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unescape } from 'node:querystring';
import jwt from 'jsonwebtoken';
import type { Context, Row } from './contracts';
import type { Database } from './database';
import { ApiError } from './errors';

export type IdentityDomain = 'v1-player' | 'v2-user';
export interface TokenPair { accessToken: string; expires: string; refreshToken: string; }
export class AuthService {
  constructor(private readonly db: Database, private readonly options: { jwtKey?: string; now?: () => number; devAuth?: boolean } = {}) {}
  private key(): KeyObject {
    if (this.options.jwtKey) return createSecretKey(Buffer.from(this.options.jwtKey));
    if (process.env.JWT_SECRET) return createSecretKey(Buffer.from(process.env.JWT_SECRET));
    // Yii HS256 uses the full file bytes as an HMAC secret, even for PEM files.
    if (process.env.JWT_KEY) { try { return createSecretKey(readFileSync(process.env.JWT_KEY)); } catch { throw new ApiError(503, 'Token signing is not configured'); } }
    throw new ApiError(503, 'Token signing is not configured');
  }
  issue(user: Row, domain: IdentityDomain, issuer: string): TokenPair {
    const now = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
    const make = (seconds: number) => jwt.sign({ uid: Number(user.id), identityDomain: domain, iss: issuer, iat: now, nbf: now, exp: now + seconds }, this.key(), { algorithm: 'HS256' });
    const expires = new Date((now + 10800) * 1000 + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ').replaceAll('-', '/');
    return { accessToken: make(10800), expires, refreshToken: make(86400) };
  }
  async verifyToken(token: string, domain: IdentityDomain): Promise<Row> {
    let claims: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(token, this.key(), { algorithms: ['HS256'], clockTimestamp: Math.floor((this.options.now?.() ?? Date.now()) / 1000) });
      if (typeof decoded === 'string' || decoded.identityDomain !== domain || !Number.isInteger(decoded.uid) || decoded.uid <= 0 || !['iat', 'nbf', 'exp'].every(field => typeof decoded[field] === 'number') || decoded.iat! > Math.floor((this.options.now?.() ?? Date.now()) / 1000)) throw new Error('Invalid identity');
      claims = decoded;
    } catch { throw new ApiError(401, 'Your request was made with invalid credentials.'); }
    const user = await this.db.one(`SELECT * FROM ${domain === 'v1-player' ? '`player`' : '`user`'} WHERE id=?`, [claims.uid]);
    if (!user) throw new ApiError(401, 'Your request was made with invalid credentials.');
    if (domain === 'v2-user') return this.role(user);
    return user;
  }
  async role(user: Row): Promise<Row> {
    const isRoot = ['15000159790', '15601920021'].includes(user.tel);
    const controls = isRoot ? [] : await this.db.query('SELECT id FROM control WHERE user_id=? LIMIT 1', [user.id]);
    const role = isRoot ? 'root' : controls.length ? 'manager' : 'user';
    if (user.role !== role) await this.db.execute('UPDATE user SET role=? WHERE id=?', [role, user.id]);
    return { ...user, role };
  }
  async bearer(ctx: Context, domain: IdentityDomain): Promise<Row> {
    const header = ctx.req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/.exec(header) : null;
    const fail = () => {
      ctx.res.setHeader('WWW-Authenticate', 'Bearer realm="api"');
      const directJwt = /^\/v2\/(?:devices|setups|root|web-login)(?:\/|$)/.test(unescape((ctx.req.path ?? '').replace(/\+/g, ' ')));
      throw new ApiError(401, directJwt ? 'Your request was made with invalid or expired JSON Web Token.' : 'Your request was made with invalid credentials.');
    };
    if (!match) return fail();
    try { return await this.verifyToken(match[1], domain); }
    catch (error) { if (error instanceof ApiError && error.status === 401) return fail(); throw error; }
  }
  async refresh(token: string, domain: IdentityDomain, issuer: string): Promise<TokenPair> {
    try { return this.issue(await this.verifyToken(token, domain), domain, issuer); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) throw new ApiError(401, 'Invalid or expired refreshToken');
      throw error;
    }
  }
  requireDevice(ctx: Context): void {
    const body = ctx.body;
    if (!body.token) throw new ApiError(400, 'token is required');
    const values = [body.uuid, body.id, body.key].filter(value => value !== undefined && value !== null && value !== '' && value !== 0 && value !== '0' && value !== false);
    if (values.length !== 1) throw new ApiError(400, 'Exactly one of uuid, id, or key must be provided');
    if (this.options.devAuth ?? process.env.GAME_DEV_AUTH === '1') return;
    if (!ctx.query.time || !ctx.query.hash) throw new ApiError(400, 'time and hash are required');
    if (typeof body.token !== 'string' || !/^[a-z][0-9a-f]{32}$/i.test(body.token)) throw new ApiError(400, 'token format error');
    const expected = createHash('md5').update(`${body.token}${ctx.query.time}${values[0]}buj1aban.c0m`).digest('hex');
    if (!this.equal(expected, ctx.query.hash)) throw new ApiError(400, 'hash error');
  }
  playerFingerprint(ctx: Context): void {
    const data = ctx.req.method === 'GET' ? ctx.query : ctx.body;
    const decode = (value: unknown) => unescape(String(value).replace(/\+/g, ' '));
    if (![data.openId, data.timestamp, data.fingerprint].every(value => typeof value === 'string' || typeof value === 'number') || !this.equal(createHash('md5').update(`geek.v0xe1.pa2ty.c0m${decode(data.timestamp)}${decode(data.openId)}`).digest('hex'), decode(data.fingerprint))) throw new ApiError(401, 'Your request was made with invalid credentials.');
  }
  private equal(left: string, right: unknown): boolean { return typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
}
