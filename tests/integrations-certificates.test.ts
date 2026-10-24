import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createPublicKey, sign, X509Certificate } from 'node:crypto';
import { Integrations } from '../src/integrations/integrations';
import fixtures from './fixtures/wechat-platform-test-keys.json';

const now = 1_800_000_000;
const primaryId = 'PUB_KEY_ID_TEST';
const [first, second] = fixtures.platforms;
const primaryKey = createPublicKey(first.privateKey).export({ type: 'spki', format: 'pem' }).toString();
const firstId = new X509Certificate(first.certificate).serialNumber;
const secondId = new X509Certificate(second.certificate).serialNumber;
const merchant = { appId: 'wx-test', mchId: 'merchant', serialNo: 'merchant-serial', privateKey: first.privateKey, apiV3Key: '12345678901234567890123456789012' };
const environmentNames = [
  'WECHAT_PAY_PLATFORM_KEYS_JSON', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH',
  'WECHAT_PAY_PLATFORM_SERIAL_NO', 'WECHAT_PUB_KEY', 'WECHAT_PUB_KEY_ID', 'WECHAT_PLATFORM_CERTS',
];
let directory: string;
let firstPath: string;
let secondPath: string;
let publicPath: string;

function legacyPrimary() {
  vi.stubEnv('WECHAT_PUB_KEY_ID', primaryId);
  vi.stubEnv('WECHAT_PUB_KEY', publicPath);
}
function reply(body: unknown, certificate = first, status = 200): Response {
  const raw = status === 204 ? '' : JSON.stringify(body);
  return new Response(status === 204 ? null : raw, { status, headers: {
    'Wechatpay-Timestamp': String(now), 'Wechatpay-Nonce': 'provider-nonce',
    'Wechatpay-Serial': new X509Certificate(certificate.certificate).serialNumber,
    'Wechatpay-Signature': sign('RSA-SHA256', Buffer.from(`${now}\nprovider-nonce\n${raw}\n`), certificate.privateKey).toString('base64'),
  } });
}
function api(fetcher: typeof fetch = async () => reply({ ok: true })) {
  return new Integrations({ ...merchant, now: () => now, fetch: fetcher });
}
async function rejectsBeforeTransport() {
  const transport = vi.fn(async () => reply({ ok: true }));
  const integration = api(transport);
  await expect(integration.payment('GET', '/v3/certificates')).rejects.toThrow(/配置|certificate|verification|WECHAT_PLATFORM_CERTS/i);
  expect(transport).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const name of environmentNames) vi.stubEnv(name, undefined);
  directory = mkdtempSync(join(tmpdir(), 'wechat-certificates-'));
  firstPath = join(directory, 'first.pem'); secondPath = join(directory, 'second.pem'); publicPath = join(directory, 'public.pem');
  writeFileSync(firstPath, first.certificate); writeFileSync(secondPath, second.certificate); writeFileSync(publicPath, primaryKey);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('Yii platform certificate environment compatibility', () => {
  it('indexes rotating X509 files by their actual serial numbers and retains the primary public key', () => {
    legacyPrimary(); vi.stubEnv('WECHAT_PLATFORM_CERTS', JSON.stringify([firstPath, secondPath]));
    expect(api().config.platformKeys).toEqual({ [primaryId]: primaryKey, [firstId]: first.certificate, [secondId]: second.certificate });
  });

  it('accepts both rotating signatures and sends the configured primary serial on every request', async () => {
    legacyPrimary(); vi.stubEnv('WECHAT_PLATFORM_CERTS', JSON.stringify([firstPath, secondPath]));
    let calls = 0;
    const integration = api(async (_input, init) => {
      expect(new Headers(init?.headers).get('Wechatpay-Serial')).toBe(primaryId);
      return reply({ sequence: ++calls }, calls === 1 ? first : second);
    });
    await expect(integration.payment('GET', '/v3/certificates')).resolves.toEqual({ sequence: 1 });
    await expect(integration.payment('GET', '/v3/certificates')).resolves.toEqual({ sequence: 2 });
  });

  it('verifies an empty signed 204 response using a rotating certificate', async () => {
    legacyPrimary(); vi.stubEnv('WECHAT_PLATFORM_CERTS', JSON.stringify([secondPath]));
    await expect(api(async () => reply(undefined, second, 204)).payment('POST', '/v3/test')).resolves.toEqual({});
  });

  it('accepts signed encrypted notifications from either configured certificate', async () => {
    legacyPrimary(); vi.stubEnv('WECHAT_PLATFORM_CERTS', JSON.stringify([firstPath, secondPath]));
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(merchant.apiV3Key), Buffer.from('nonce-123456'));
    cipher.setAAD(Buffer.from('transaction'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ mchid: merchant.mchId, appid: merchant.appId })), cipher.final(), cipher.getAuthTag()]).toString('base64');
    const raw = JSON.stringify({ id: 'notification', resource: { algorithm: 'AEAD_AES_256_GCM', nonce: 'nonce-123456', associated_data: 'transaction', ciphertext } });
    const integration = api();
    for (const certificate of [first, second]) {
      const headers = { 'wechatpay-timestamp': String(now), 'wechatpay-nonce': 'notice-nonce', 'wechatpay-serial': new X509Certificate(certificate.certificate).serialNumber,
        'wechatpay-signature': sign('RSA-SHA256', Buffer.from(`${now}\nnotice-nonce\n${raw}\n`), certificate.privateKey).toString('base64') };
      await expect(integration.notification(raw, headers)).resolves.toMatchObject({ id: 'notification', resource: { mchid: merchant.mchId } });
    }
  });

  it('permits repeated references to the exact same certificate path', () => {
    legacyPrimary(); vi.stubEnv('WECHAT_PLATFORM_CERTS', JSON.stringify([firstPath, firstPath]));
    expect(api().config.platformKeys?.[firstId]).toBe(first.certificate);
  });

  it('rejects the same serial referenced from different paths before transport', async () => {
    const copyPath = join(directory, 'copy.pem'); writeFileSync(copyPath, first.certificate);
    legacyPrimary(); vi.stubEnv('WECHAT_PLATFORM_CERTS', JSON.stringify([firstPath, copyPath]));
    await rejectsBeforeTransport();
  });

  it('rejects a primary certificate serial collision from a different path', async () => {
    legacyPrimary(); vi.stubEnv('WECHAT_PUB_KEY_ID', firstId); vi.stubEnv('WECHAT_PLATFORM_CERTS', JSON.stringify([firstPath]));
    await rejectsBeforeTransport();
  });

  it('permits the primary certificate path to reappear under its own serial', () => {
    vi.stubEnv('WECHAT_PUB_KEY_ID', firstId); vi.stubEnv('WECHAT_PUB_KEY', firstPath);
    vi.stubEnv('WECHAT_PLATFORM_CERTS', JSON.stringify([firstPath]));
    expect(api().config.platformKeys?.[firstId]).toBe(first.certificate);
  });

  it.each(['{', '{}', 'null', '1', '"path"', '[null]', '[1]', '[""]'])('rejects invalid legacy path-list value %s before transport', async value => {
    legacyPrimary(); vi.stubEnv('WECHAT_PLATFORM_CERTS', value); await rejectsBeforeTransport();
  });

  it.each(['missing', 'directory', 'public-key'])('rejects an unreadable or non-certificate additional file: %s', async type => {
    const path = type === 'directory' ? directory : type === 'public-key' ? publicPath : join(directory, 'missing.pem');
    legacyPrimary(); vi.stubEnv('WECHAT_PLATFORM_CERTS', JSON.stringify([path])); await rejectsBeforeTransport();
  });

  it.each(['missing-id', 'missing-key', 'invalid-key', 'missing-file'])('rejects incomplete legacy primary verification: %s', async type => {
    legacyPrimary();
    if (type === 'missing-id') vi.stubEnv('WECHAT_PUB_KEY_ID', undefined);
    if (type === 'missing-key') vi.stubEnv('WECHAT_PUB_KEY', undefined);
    if (type === 'invalid-key') { writeFileSync(publicPath, 'invalid PEM'); }
    if (type === 'missing-file') vi.stubEnv('WECHAT_PUB_KEY', join(directory, 'missing.pem'));
    await rejectsBeforeTransport();
  });

  it('requires a primary verification key for a legacy certificate list', async () => {
    vi.stubEnv('WECHAT_PLATFORM_CERTS', JSON.stringify([firstPath])); await rejectsBeforeTransport();
  });

  it('keeps modern map precedence over legacy primary and additional certificates', () => {
    legacyPrimary(); vi.stubEnv('WECHAT_PLATFORM_CERTS', JSON.stringify([firstPath]));
    vi.stubEnv('WECHAT_PAY_PLATFORM_KEYS_JSON', JSON.stringify({ [primaryId]: 'modern-primary', [firstId]: 'modern-rotation' }));
    expect(api().config.platformKeys).toMatchObject({ [primaryId]: 'modern-primary', [firstId]: 'modern-rotation' });
  });

  it('keeps an explicit modern key above its modern map entry', () => {
    vi.stubEnv('WECHAT_PAY_PLATFORM_KEYS_JSON', JSON.stringify({ [primaryId]: 'map-key' }));
    vi.stubEnv('WECHAT_PAY_PLATFORM_SERIAL_NO', primaryId); vi.stubEnv('WECHAT_PAY_PLATFORM_PUBLIC_KEY', primaryKey);
    expect(api().config.platformKeys?.[primaryId]).toBe(primaryKey);
  });

  it('allows a complete modern map without a legacy primary or outbound serial header', async () => {
    vi.stubEnv('WECHAT_PAY_PLATFORM_KEYS_JSON', JSON.stringify({ [firstId]: first.certificate }));
    await expect(api().payment('GET', '/v3/certificates')).resolves.toEqual({ ok: true });
  });

  it('does not read a retired legacy primary path when a modern map supplies that ID', async () => {
    vi.stubEnv('WECHAT_PUB_KEY_ID', firstId); vi.stubEnv('WECHAT_PUB_KEY', join(directory, 'retired.pem'));
    vi.stubEnv('WECHAT_PAY_PLATFORM_KEYS_JSON', JSON.stringify({ [firstId]: first.certificate }));
    await expect(api().payment('GET', '/v3/certificates')).resolves.toEqual({ ok: true });
  });

  it('never hides a malformed legacy list behind a complete modern configuration', async () => {
    vi.stubEnv('WECHAT_PAY_PLATFORM_KEYS_JSON', JSON.stringify({ [firstId]: first.certificate }));
    vi.stubEnv('WECHAT_PLATFORM_CERTS', '[null]'); await rejectsBeforeTransport();
  });

  it('defers a bad payment certificate configuration without breaking login and cloud metadata', async () => {
    vi.stubEnv('WECHAT_PLATFORM_CERTS', '[null]');
    const integration = new Integrations({ appId: 'wx-test', appSecret: 'test-secret', bucket: 'test-1', region: 'test-region', fetch: async () => Response.json({ openid: 'verified' }) });
    expect(integration.cloud()).toEqual({ bucket: 'test-1', region: 'test-region' });
    await expect(integration.codeSession('code')).resolves.toMatchObject({ openid: 'verified' });
    await expect(integration.notification('{}', {})).rejects.toThrow(/配置|certificate|verification|WECHAT_PLATFORM_CERTS/i);
  });
});
