import { HttpException } from '@nestjs/common';
import { createDecipheriv, createHash, createHmac, randomBytes, sign, verify, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Row } from '../core/contracts';

/** Actual provider transports. No endpoint forwards to the retired PHP service. */
export interface IntegrationOptions {
  appId?: string; appSecret?: string; mchId?: string; serialNo?: string; privateKey?: string;
  apiV3Key?: string; platformKeys?: Record<string, string>; platformKeyId?: string; notifyUrl?: string; refundNotifyUrl?: string;
  secretId?: string; secretKey?: string; bucket?: string; region?: string;
  fetch?: typeof fetch; now?: () => number; nonce?: () => string;
  onPaymentNotification?: (notice: Row) => Promise<void>;
}

function pem(value: string | undefined, path: string | undefined): string | undefined {
  if (value) return value.replace(/\\n/g, '\n');
  if (!path) return undefined;
  // EasyWeChat accepts either a PEM value or a file path in the legacy variables.
  return path.trimStart().startsWith('-----BEGIN ') ? path.replace(/\\n/g, '\n') : readFileSync(path, 'utf8');
}
function environment(): IntegrationOptions {
  const env = process.env;
  const keys: Record<string, string> = env.WECHAT_PAY_PLATFORM_KEYS_JSON ? JSON.parse(env.WECHAT_PAY_PLATFORM_KEYS_JSON) : {};
  const key = pem(env.WECHAT_PAY_PLATFORM_PUBLIC_KEY, env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH || env.WECHAT_PUB_KEY);
  const publicKeyId = env.WECHAT_PAY_PLATFORM_SERIAL_NO || env.WECHAT_PUB_KEY_ID;
  if (key && publicKeyId && (!keys[publicKeyId] || env.WECHAT_PAY_PLATFORM_PUBLIC_KEY || env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH)) keys[publicKeyId] = key;
  const serialNo = env.WECHAT_PAY_SERIAL_NO || (env.WECHAT_CERTIFICATE ? new X509Certificate(pem(undefined, env.WECHAT_CERTIFICATE)!).serialNumber : undefined);
  return {
    appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET || env.WECHAT_SECRET,
    mchId: env.WECHAT_PAY_MCH_ID || env.WECHAT_MCH_ID, serialNo,
    privateKey: pem(env.WECHAT_PAY_PRIVATE_KEY, env.WECHAT_PAY_PRIVATE_KEY_PATH || env.WECHAT_PRIVATE_KEY),
    apiV3Key: env.WECHAT_PAY_API_V3_KEY || env.WECHAT_SECRET_KEY, platformKeys: keys, platformKeyId: publicKeyId,
    notifyUrl: env.WECHAT_PAY_NOTIFY_URL,
    refundNotifyUrl: env.WECHAT_PAY_REFUND_NOTIFY_URL,
    secretId: env.TENCENT_SECRET_ID || env.SECRET_ID, secretKey: env.TENCENT_SECRET_KEY || env.SECRET_KEY,
    bucket: env.COS_BUCKET || env.COS_BUCKETS_BUCKET, region: env.COS_REGION || env.COS_BUCKETS_REGION,
  };
}
function failure(status: number, message: string, yiiType = 'HttpException'): never { throw Object.assign(new HttpException(message, status), { yiiType }); }
function record(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value); }
function enc(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac256 = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
const hmac1 = (key: string, value: string) => createHmac('sha1', key).update(value).digest('hex');

export class Integrations {
  readonly config: IntegrationOptions;
  private readonly fetcher: typeof fetch;
  readonly now: () => number;
  private readonly nonce: () => string;
  private accessToken?: { value: string; expires: number };
  private accessTokenRequest?: Promise<string>;

  constructor(options: IntegrationOptions = {}) {
    this.config = { ...environment(), ...options };
    this.fetcher = options.fetch || globalThis.fetch;
    this.now = options.now || (() => Math.floor(Date.now() / 1000));
    this.nonce = options.nonce || (() => randomBytes(16).toString('hex'));
  }

  private required(...names: (keyof IntegrationOptions)[]): void {
    if (names.some(name => !this.config[name])) failure(503, '外部服务配置不完整');
  }
  private async transport(url: string, init: RequestInit = {}): Promise<Response> {
    try { return await this.fetcher(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
    catch { return failure(503, '外部服务暂时不可用'); }
  }
  private async wechat(path: string, data?: Row): Promise<Row> {
    const response = await this.transport(`https://api.weixin.qq.com${path}`, data ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    } : {});
    let result: unknown;
    try { result = await response.json(); } catch { return failure(502, '微信服务返回格式无效'); }
    if (!response.ok || !record(result) || (result.errcode !== undefined && Number(result.errcode) !== 0)) return failure(400, '微信服务请求失败，请重新授权');
    return result;
  }

  async codeSession(code: string): Promise<Row> {
    if (typeof code !== 'string' || !code || Buffer.byteLength(code) > 1024) return failure(400, 'code is required');
    this.required('appId', 'appSecret');
    const query = new URLSearchParams({ appid: this.config.appId!, secret: this.config.appSecret!, js_code: code, grant_type: 'authorization_code' });
    const result = await this.wechat(`/sns/jscode2session?${query}`);
    if (typeof result.openid !== 'string' || !result.openid) return failure(401, '微信登录失败，请重新登录', 'UnauthorizedHttpException');
    return result;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expires > this.now() + 60) return this.accessToken.value;
    if (!this.accessTokenRequest) {
      this.accessTokenRequest = (async () => {
        this.required('appId', 'appSecret');
        const result = await this.wechat('/cgi-bin/stable_token', { grant_type: 'client_credential', appid: this.config.appId, secret: this.config.appSecret, force_refresh: false });
        if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(Number(result.expires_in))) return failure(502, '微信访问凭证无效');
        this.accessToken = { value: result.access_token, expires: this.now() + Number(result.expires_in) };
        return this.accessToken.value;
      })().finally(() => { this.accessTokenRequest = undefined; });
    }
    return this.accessTokenRequest;
  }

  async phone(code: string): Promise<Row> {
    if (typeof code !== 'string' || !code || code.length > 1024) return failure(400, 'code parameter is required');
    const token = await this.token();
    const result = await this.wechat(`/wxa/business/getuserphonenumber?access_token=${enc(token)}`, { code });
    if (!record(result.phone_info) || typeof result.phone_info.phoneNumber !== 'string' || !result.phone_info.phoneNumber) return failure(400, '微信手机号响应无效');
    const watermark = result.phone_info.watermark;
    if (watermark && watermark.appid !== this.config.appId) return failure(400, '微信手机号身份不匹配');
    return result.phone_info;
  }

  /** APIv3 signatures always cover raw bytes, including trailing newlines. */
  private verifyPayment(raw: string, headers: Headers | Record<string, unknown>): void {
    const get = (name: string): string => headers instanceof Headers ? headers.get(name) || '' : String(headers[name] || headers[name.toLowerCase()] || Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] || '');
    const timestamp = get('wechatpay-timestamp');
    const nonce = get('wechatpay-nonce');
    const serial = get('wechatpay-serial');
    const signature = get('wechatpay-signature');
    const key = this.config.platformKeys?.[serial];
    if (!/^\d+$/.test(timestamp) || Math.abs(this.now() - Number(timestamp)) > 300 || !nonce || !key || !signature || signature.startsWith('WECHATPAY/SIGNTEST/')) return failure(401, '微信支付签名校验失败');
    try {
      if (!verify('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), key, Buffer.from(signature, 'base64'))) return failure(401, '微信支付签名校验失败');
    } catch { return failure(401, '微信支付签名校验失败'); }
  }

  async payment(method: string, path: string, data?: Row): Promise<Row> {
    this.required('mchId', 'serialNo', 'privateKey');
    if (!path.startsWith('/v3/')) return failure(400, '支付请求路径无效');
    const body = data === undefined ? '' : JSON.stringify(data);
    const timestamp = String(this.now());
    const nonce = this.nonce();
    const signature = sign('RSA-SHA256', Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`), this.config.privateKey!).toString('base64');
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.config.serialNo}",signature="${signature}"`;
    const platformKeyId = this.config.platformKeyId || Object.keys(this.config.platformKeys || {}).find(id => id.startsWith('PUB_KEY_ID_'));
    const response = await this.transport(`https://api.mch.weixin.qq.com${path}`, { method, headers: { Accept: 'application/json', 'Accept-Language': 'zh-CN', 'Content-Type': 'application/json', Authorization: authorization, ...(platformKeyId ? { 'Wechatpay-Serial': platformKeyId } : {}) }, ...(body ? { body } : {}) });
    const raw = await response.text();
    this.verifyPayment(raw, response.headers);
    let result: unknown;
    try { result = raw ? JSON.parse(raw) : {}; } catch { return failure(502, '微信支付响应格式无效'); }
    if (!response.ok) return failure(response.status === 404 ? 404 : 502, response.status === 404 ? '订单不存在' : '微信支付请求失败');
    if (!record(result)) return failure(502, '微信支付响应格式无效');
    return result;
  }

  async order(input: Row, fallbackNotifyUrl?: string): Promise<Row> {
    this.required('appId');
    const notifyUrl = this.config.notifyUrl || fallbackNotifyUrl;
    if (!notifyUrl) return failure(503, '外部服务配置不完整');
    const result = await this.payment('POST', '/v3/pay/transactions/jsapi', {
      appid: this.config.appId, mchid: this.config.mchId, description: input.description === undefined ? '商品支付' : input.description,
      out_trade_no: input.out_trade_no, notify_url: notifyUrl,
      ...(typeof input.attach === 'string' ? { attach: input.attach } : {}),
      amount: { total: Number(input.amount), currency: 'CNY' }, payer: { openid: input.openid },
    });
    if (typeof result.prepay_id !== 'string' || !result.prepay_id) return failure(502, '获取prepay_id失败');
    const timeStamp = String(this.now()), nonceStr = this.nonce(), packageValue = `prepay_id=${result.prepay_id}`;
    const paySign = sign('RSA-SHA256', Buffer.from(`${this.config.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`), this.config.privateKey!).toString('base64');
    return { appId: this.config.appId, timeStamp, nonceStr, package: packageValue, signType: 'RSA', paySign };
  }

  async notification(raw: string | Buffer, headers: Headers | Record<string, unknown>): Promise<Row> {
    this.required('apiV3Key', 'mchId');
    const text = raw.toString();
    this.verifyPayment(text, headers);
    let notice: Row;
    try { notice = JSON.parse(text); } catch { return failure(400, '微信支付通知格式无效'); }
    if (!record(notice)) return failure(400, '微信支付通知格式无效');
    const resource = notice.resource;
    if (!record(resource) || resource.algorithm !== 'AEAD_AES_256_GCM' || typeof resource.ciphertext !== 'string' || typeof resource.nonce !== 'string') return failure(400, '微信支付通知加密格式无效');
    try {
      const ciphertext = Buffer.from(resource.ciphertext, 'base64');
      if (ciphertext.length <= 16 || Buffer.byteLength(this.config.apiV3Key!) !== 32) throw Error();
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.config.apiV3Key!), Buffer.from(resource.nonce));
      decipher.setAuthTag(ciphertext.subarray(-16));
      decipher.setAAD(Buffer.from(resource.associated_data || ''));
      const decrypted = JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString());
      if (!record(decrypted)) throw Error();
      if (decrypted.mchid !== this.config.mchId || (decrypted.appid && decrypted.appid !== this.config.appId)) return failure(400, '微信支付通知商户身份不匹配');
      return { ...notice, resource: decrypted };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return failure(400, '微信支付通知解密失败');
    }
  }

  cloud(): Row {
    return { bucket: this.config.bucket ?? false, region: this.config.region ?? false };
  }

  async federationToken(bucket = this.config.bucket, region = this.config.region): Promise<Row> {
    this.required('secretId', 'secretKey', 'bucket', 'region');
    if (bucket !== this.config.bucket || region !== this.config.region) return failure(400, '只能访问已配置的存储桶');
    const match = /^([a-z\d][a-z\d-]*)-(\d+)$/.exec(bucket!);
    if (!match) return failure(503, 'COS 存储桶配置无效');
    const policy = { version: '2.0', statement: [{ action: ['name/cos:PutObject', 'name/cos:PostObject', 'name/cos:HeadObject', 'name/cos:GetObject', 'name/cos:InitiateMultipartUpload', 'name/cos:ListMultipartUploads', 'name/cos:ListParts', 'name/cos:UploadPart', 'name/cos:CompleteMultipartUpload'], effect: 'allow', resource: [`qcs::cos:${region}:uid/${match[2]}:prefix//${match[2]}/${match[1]}/*`] }] };
    const body = JSON.stringify({ Name: 'mrpp', Policy: enc(JSON.stringify(policy)), DurationSeconds: 1800 });
    const timestamp = this.now(), date = new Date(timestamp * 1000).toISOString().slice(0, 10), host = 'sts.tencentcloudapi.com';
    const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${sha256(body)}`;
    const scope = `${date}/sts/tc3_request`;
    const secretDate = hmac256(`TC3${this.config.secretKey}`, date);
    const signature = hmac256(hmac256(hmac256(secretDate, 'sts'), 'tc3_request'), `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`).toString('hex');
    const response = await this.transport(`https://${host}/`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Host: host, 'X-TC-Action': 'GetFederationToken', 'X-TC-Version': '2018-08-13', 'X-TC-Region': region!, 'X-TC-Timestamp': String(timestamp), Authorization: `TC3-HMAC-SHA256 Credential=${this.config.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}` }, body });
    let result: Row;
    try { result = (await response.json()).Response; } catch { return failure(502, '腾讯云响应格式无效'); }
    if (!response.ok || !record(result) || result.Error || !record(result.Credentials) || typeof result.Credentials.Token !== 'string' || typeof result.Credentials.TmpSecretId !== 'string' || typeof result.Credentials.TmpSecretKey !== 'string' || !Number.isFinite(Number(result.ExpiredTime))) return failure(502, '腾讯云临时凭证请求失败');
    return result;
  }

  async store(): Promise<Row> {
    const result = await this.federationToken();
    return { message: 'success', success: true, data: { ...this.cloud(), token: result.Credentials.Token, tmpSecretId: result.Credentials.TmpSecretId, tmpSecretKey: result.Credentials.TmpSecretKey, startTime: this.now(), expiredTime: result.ExpiredTime, expiration: result.Expiration ?? null, requestId: result.RequestId } };
  }

  async objectUrl(key: string, query: Row = {}, expiresAt?: number): Promise<string> {
    return this.signedObjectUrl(key, query, {}, expiresAt);
  }

  private async signedObjectUrl(key: string, query: Row = {}, extraHeaders: Record<string, string> = {}, expiresAt?: number): Promise<string> {
    this.required('secretId', 'secretKey', 'bucket', 'region');
    if (typeof key !== 'string' || !key || key.length > 1024 || key.split('/').some(part => part === '..' || part === '.') || /[\u0000-\u001f\\]/.test(key)) return failure(400, 'key is invalid');
    const expires = query.expires === undefined ? 900 : Number(query.expires);
    const method = String(query.method || 'GET').toUpperCase();
    if (!Number.isInteger(expires) || expires < 1 || expires > 86400) return failure(400, 'expires must be between 1 and 86400');
    if (!['GET', 'HEAD', 'PUT'].includes(method)) return failure(400, 'method must be GET, HEAD or PUT');
    let secretId = this.config.secretId!, secretKey = this.config.secretKey!, token: string | undefined;
    let end = expiresAt ?? this.now() + expires;
    if (String(query.force_sts || '') === '1') {
      const sts = await this.federationToken();
      secretId = sts.Credentials.TmpSecretId; secretKey = sts.Credentials.TmpSecretKey; token = sts.Credentials.Token;
      end = Math.min(end, Number(sts.ExpiredTime));
    }
    const host = `${this.config.bucket}.cos.${this.config.region}.myqcloud.com`;
    const pathname = `/${key.replace(/^\//, '').split('/').map(enc).join('/')}`;
    const parameters: Record<string, string> = {};
    for (const name of ['response-content-type', 'response-content-disposition', 'response-cache-control', 'response-content-language', 'response-content-encoding', 'response-expires']) if (typeof query[name] === 'string') parameters[name] = query[name];
    if (query.disposition) parameters['response-content-disposition'] = String(query.disposition);
    const headers: Record<string, string> = { host, ...extraHeaders };
    if (query.contentType) headers['content-type'] = String(query.contentType);
    const headerKeys = Object.keys(headers).sort(), parameterKeys = Object.keys(parameters).sort();
    const httpString = `${method.toLowerCase()}\n${decodeURIComponent(pathname)}\n${parameterKeys.map(name => `${enc(name).toLowerCase()}=${enc(parameters[name])}`).join('&')}\n${headerKeys.map(name => `${enc(name)}=${enc(headers[name])}`).join('&')}\n`;
    const time = `${this.now()};${end}`;
    const stringToSign = `sha1\n${time}\n${createHash('sha1').update(httpString).digest('hex')}\n`;
    const signature = hmac1(hmac1(secretKey, time), stringToSign);
    const output = new URLSearchParams({ 'q-sign-algorithm': 'sha1', 'q-ak': secretId, 'q-sign-time': time, 'q-key-time': time, 'q-header-list': headerKeys.join(';'), 'q-url-param-list': parameterKeys.join(';'), 'q-signature': signature, ...parameters });
    if (token) output.set('x-cos-security-token', token);
    return `https://${host}${pathname}?${output}`;
  }

  async fileMetadata(key: string): Promise<Row> {
    const headers = { 'x-cos-meta-need-md5': '1' };
    const url = await this.signedObjectUrl(key, { method: 'HEAD', expires: 60 }, headers);
    const response = await this.transport(url, { method: 'HEAD', headers });
    if (!response.ok) return failure(response.status === 404 ? 404 : 502, response.status === 404 ? '文件不存在' : 'COS 文件信息查询失败');
    const size = Number(response.headers.get('content-length'));
    const etag = (response.headers.get('etag') || '').replace(/^"|"$/g, '');
    const lastModified = Date.parse(response.headers.get('last-modified') || '');
    const createdAt = new Date((Number.isFinite(lastModified) ? lastModified : this.now() * 1000) + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    return { key, type: response.headers.get('content-type') || 'application/octet-stream', size: Number.isFinite(size) ? size : 0, md5: response.headers.get('x-cos-hash-md5') || response.headers.get('x-cos-meta-md5') || etag, bucket: this.config.bucket, created_at: createdAt };
  }
}

export { registerIntegrations } from './routes';
