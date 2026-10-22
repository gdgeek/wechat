import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, generateKeyPairSync, sign, verify, X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { Integrations } from '../src/integrations/integrations';

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const platformKey = platform.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const now = 1_800_000_000;
const config = {
  appId: 'wx-test', appSecret: 'test-secret', mchId: 'merchant', serialNo: 'merchant-serial',
  privateKey, apiV3Key: '12345678901234567890123456789012',
  platformKeys: { 'platform-serial': platformKey }, platformKeyId: 'platform-serial', notifyUrl: 'https://example.test/v1/wechat-pay/notify',
  secretId: 'test-id', secretKey: 'test-cloud-key', bucket: 'test-1250000000', region: 'ap-nanjing',
};
function paidResponse(body: unknown, status = 200): Response {
  const raw = JSON.stringify(body);
  const signature = sign('RSA-SHA256', Buffer.from(`${now}\nresponse-nonce\n${raw}\n`), platform.privateKey).toString('base64');
  return new Response(raw, { status, headers: { 'Wechatpay-Timestamp': String(now), 'Wechatpay-Nonce': 'response-nonce', 'Wechatpay-Serial': 'platform-serial', 'Wechatpay-Signature': signature } });
}
function service(fetcher: typeof fetch) { return new Integrations({ ...config, fetch: fetcher, now: () => now, nonce: () => 'request-nonce' }); }

describe('provider integrations', () => {
  it('exchanges a WeChat code, rejects provider errors, and never accepts a missing openid', async () => {
    let requested = '';
    const api = service(async (input) => { requested = String(input); return Response.json({ openid: 'verified', session_key: 'private-session', unionid: 'union' }); });
    expect((await api.codeSession('fresh-code')).openid).toBe('verified');
    expect(new URL(requested).searchParams.get('js_code')).toBe('fresh-code');
    expect(new URL(requested).hostname).toBe('api.weixin.qq.com');
    await expect(service(async () => Response.json({ errcode: 40029, errmsg: 'invalid code' })).codeSession('bad')).rejects.toThrow('微信');
    await expect(service(async () => Response.json({})).codeSession('bad')).rejects.toThrow('微信');
  });

  it('signs the exact APIv3 request body and verifies the returned signature', async () => {
    const api = service(async (input, init) => {
      const auth = String(new Headers(init?.headers).get('Authorization'));
      expect(new Headers(init?.headers).get('Wechatpay-Serial')).toBe('platform-serial');
      const signature = /signature="([^"]+)"/.exec(auth)![1];
      const url = new URL(String(input));
      expect(verify('RSA-SHA256', Buffer.from(`POST\n${url.pathname}\n${now}\nrequest-nonce\n${init?.body}\n`), merchant.publicKey, Buffer.from(signature, 'base64'))).toBe(true);
      return paidResponse({ prepay_id: 'prepay' });
    });
    const result = await api.payment('POST', '/v3/pay/transactions/jsapi', { amount: { total: 100 } });
    expect(result.prepay_id).toBe('prepay');
    await expect(service(async () => Response.json({ prepay_id: 'forged' })).payment('POST', '/v3/pay/transactions/jsapi', {})).rejects.toThrow('签名');
  });

  it('decrypts a signed notification and rejects tampering, unknown serial and stale replay', async () => {
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.apiV3Key), Buffer.from('nonce-123456'));
    cipher.setAAD(Buffer.from('transaction'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ mchid: 'merchant', appid: 'wx-test', out_trade_no: 'order1', trade_state: 'SUCCESS' })), cipher.final(), cipher.getAuthTag()]).toString('base64');
    const raw = JSON.stringify({ id: 'notice1', event_type: 'TRANSACTION.SUCCESS', resource: { algorithm: 'AEAD_AES_256_GCM', nonce: 'nonce-123456', associated_data: 'transaction', ciphertext } });
    const signature = sign('RSA-SHA256', Buffer.from(`${now}\nnotice-nonce\n${raw}\n`), platform.privateKey).toString('base64');
    const headers = { 'wechatpay-timestamp': String(now), 'wechatpay-nonce': 'notice-nonce', 'wechatpay-serial': 'platform-serial', 'wechatpay-signature': signature };
    const api = service(async () => { throw Error('unexpected network'); });
    expect((await api.notification(raw, headers)).resource.out_trade_no).toBe('order1');
    await expect(api.notification(raw + ' ', headers)).rejects.toThrow('签名');
    await expect(api.notification(raw, { ...headers, 'wechatpay-serial': 'unknown' })).rejects.toThrow('签名');
    await expect(api.notification(raw, { ...headers, 'wechatpay-timestamp': String(now - 600) })).rejects.toThrow('签名');
    const forged = JSON.stringify({ resource: { algorithm: 'AEAD_AES_256_GCM', nonce: 'nonce-123456', ciphertext } });
    const forgedHeaders = { ...headers, 'wechatpay-signature': sign('RSA-SHA256', Buffer.from(`${now}\nnotice-nonce\n${forged}\n`), platform.privateKey).toString('base64') };
    await expect(api.notification(forged, forgedHeaders)).rejects.toThrow('解密');
    const invalidBody = 'null';
    const invalidHeaders = { ...headers, 'wechatpay-signature': sign('RSA-SHA256', Buffer.from(`${now}\nnotice-nonce\n${invalidBody}\n`), platform.privateKey).toString('base64') };
    await expect(api.notification(invalidBody, invalidHeaders)).rejects.toThrow('格式无效');
  });

  it('signs STS requests and scopes the encoded policy to the configured COS bucket', async () => {
    const api = service(async (input, init) => {
      expect(String(input)).toBe('https://sts.tencentcloudapi.com/');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toContain('TC3-HMAC-SHA256 Credential=test-id/');
      expect(headers.get('X-TC-Action')).toBe('GetFederationToken');
      const data = JSON.parse(String(init?.body));
      const policy = JSON.parse(decodeURIComponent(data.Policy));
      expect(policy.statement[0].principal).toBeUndefined();
      expect(policy.statement[0].resource[0]).toBe('qcs::cos:ap-nanjing:uid/1250000000:prefix//1250000000/test/*');
      return Response.json({ Response: { Credentials: { Token: 'temporary', TmpSecretId: 'tmp-id', TmpSecretKey: 'tmp-key' }, ExpiredTime: now + 1800, RequestId: 'req' } });
    });
    expect((await api.store()).data.tmpSecretId).toBe('tmp-id');
    await expect(api.federationToken('other-1250000000', 'ap-nanjing')).rejects.toThrow('存储桶');
    await expect(service(async () => Response.json({ Response: { Error: { Code: 'Denied', Message: 'denied' } } })).store()).rejects.toThrow('腾讯云');
  });

  it('generates bounded signed COS URLs and reads real HEAD metadata', async () => {
    const api = service(async (input, init) => {
      expect(init?.method).toBe('HEAD');
      expect(String(input)).toContain('/folder/a%20b.png?');
      expect(new Headers(init?.headers).get('x-cos-meta-need-md5')).toBe('1');
      expect(new URL(String(input)).searchParams.get('q-header-list')).toContain('x-cos-meta-need-md5');
      return new Response(null, { headers: { 'content-type': 'image/png', 'content-length': '42', etag: '"abcdef"', 'x-cos-meta-owner': 'user1', 'x-cos-hash-md5': 'official-md5', 'last-modified': 'Fri, 01 Jan 2027 00:00:00 GMT' } });
    });
    const url = new URL(await api.objectUrl('folder/a b.png', { expires: 60 }));
    expect(url.searchParams.get('q-sign-time')).toBe(`${now};${now + 60}`);
    expect(url.searchParams.get('q-signature')).toMatch(/^[a-f0-9]{40}$/);
    expect(await api.fileMetadata('folder/a b.png')).toMatchObject({ type: 'image/png', size: 42, md5: 'official-md5', bucket: config.bucket, created_at: '2027-01-01 08:00:00' });
    await expect(api.objectUrl('../escape', {})).rejects.toThrow('key');
    await expect(api.objectUrl('a', { expires: 86401 })).rejects.toThrow('expires');
  });

  it('caches only valid phone access tokens and rejects mismatched app identity', async () => {
    let tokenRequests = 0;
    let phoneRequests = 0;
    const api = service(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/cgi-bin/stable_token') {
        tokenRequests++;
        expect(JSON.parse(String(init?.body))).toMatchObject({ appid: 'wx-test', grant_type: 'client_credential' });
        return Response.json({ access_token: 'provider-token', expires_in: 7200 });
      }
      phoneRequests++;
      expect(url.searchParams.get('access_token')).toBe('provider-token');
      return Response.json({ errcode: 0, phone_info: { phoneNumber: '8613800000000', purePhoneNumber: '13800000000', countryCode: '86', watermark: { appid: phoneRequests > 2 ? 'wrong-app' : 'wx-test' } } });
    });
    expect((await api.phone('code1')).countryCode).toBe('86');
    expect((await api.phone('code2')).phoneNumber).toBe('8613800000000');
    expect(tokenRequests).toBe(1);
    await expect(api.phone('code3')).rejects.toThrow('身份不匹配');
    await expect(service(async () => Response.json({ errcode: 40013 })).phone('invalid')).rejects.toThrow('微信');
  });

  it('accepts existing Yii environment aliases with modern variable precedence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wechat-integration-'));
    const keyPath = join(directory, 'private.pem');
    const publicPath = join(directory, 'public.pem');
    writeFileSync(keyPath, privateKey);
    writeFileSync(publicPath, platformKey);
    const old = { WECHAT_SECRET: 'old-app-secret', WECHAT_MCH_ID: 'old-merchant', WECHAT_PRIVATE_KEY: keyPath, WECHAT_PUB_KEY_ID: 'old-platform-id', WECHAT_PUB_KEY: publicPath, WECHAT_SECRET_KEY: 'old-v3-key', SECRET_ID: 'old-id', SECRET_KEY: 'old-key', COS_BUCKETS_BUCKET: 'old-1250000000', COS_BUCKETS_REGION: 'ap-beijing' };
    const modern = ['WECHAT_APP_SECRET', 'WECHAT_PAY_MCH_ID', 'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_PRIVATE_KEY_PATH', 'WECHAT_PAY_PLATFORM_KEYS_JSON', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH', 'WECHAT_PAY_PLATFORM_SERIAL_NO', 'WECHAT_PAY_API_V3_KEY', 'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'COS_BUCKET', 'COS_REGION'];
    try {
      for (const name of modern) vi.stubEnv(name, undefined);
      for (const [name, value] of Object.entries(old)) vi.stubEnv(name, value);
      const api = new Integrations();
      expect(api.config).toMatchObject({ appSecret: 'old-app-secret', mchId: 'old-merchant', privateKey, platformKeys: { 'old-platform-id': platformKey }, apiV3Key: 'old-v3-key', secretId: 'old-id', secretKey: 'old-key', bucket: 'old-1250000000', region: 'ap-beijing' });
      vi.stubEnv('WECHAT_APP_SECRET', 'new-secret');
      vi.stubEnv('COS_BUCKET', 'new-1250000000');
      expect(new Integrations().config).toMatchObject({ appSecret: 'new-secret', bucket: 'new-1250000000' });
    } finally { vi.unstubAllEnvs(); rmSync(directory, { recursive: true }); }
  });

  it('accepts an inline PEM in the existing Yii merchant private-key variable', () => {
    try {
      vi.stubEnv('WECHAT_PAY_PRIVATE_KEY', undefined);
      vi.stubEnv('WECHAT_PAY_PRIVATE_KEY_PATH', undefined);
      vi.stubEnv('WECHAT_PRIVATE_KEY', privateKey);
      expect(new Integrations().config.privateKey).toBe(privateKey);
    } finally { vi.unstubAllEnvs(); }
  });

  it('accepts inline PEMs in the existing Yii certificate and platform public-key variables', () => {
    try {
      for (const name of ['WECHAT_PAY_SERIAL_NO', 'WECHAT_PAY_PLATFORM_KEYS_JSON', 'WECHAT_PAY_PLATFORM_SERIAL_NO', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH']) vi.stubEnv(name, undefined);
      // A bundled public certificate exercises parsing without any merchant credentials.
      vi.stubEnv('WECHAT_CERTIFICATE', rootCertificates[0]);
      vi.stubEnv('WECHAT_PUB_KEY_ID', 'legacy-platform');
      vi.stubEnv('WECHAT_PUB_KEY', platformKey);
      expect(new Integrations().config).toMatchObject({ serialNo: new X509Certificate(rootCertificates[0]).serialNumber, platformKeys: { 'legacy-platform': platformKey } });
    } finally { vi.unstubAllEnvs(); }
  });
});
