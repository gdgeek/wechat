/* Run with node --import tsx; this optional check never runs during Node CI. */
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { existsSync, realpathSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { AdminTokens } = require('../src/admin/tokens.ts');
const { AdminTokenStore } = require('../src/admin/token-store.ts');
const { LegacyRedis } = require('../src/core/redis.ts');

async function main() {
  const host = process.env.ADMIN_AUTH_REDIS_HOST, port = Number(process.env.ADMIN_AUTH_REDIS_PORT);
  if (process.env.RUN_YII_ADMIN_INTEROP !== '1' || !['127.0.0.1', 'localhost'].includes(host)
    || !process.env.ADMIN_AUTH_REDIS_PORT || !Number.isInteger(port) || port <= 1024 || port > 65535 || port === 6379
    || process.env.ADMIN_AUTH_REDIS_DB !== '15') {
    throw new Error('Set RUN_YII_ADMIN_INTEROP=1 and explicitly select an isolated localhost Redis test port (not 6379), ADMIN_AUTH_REDIS_DB=15.');
  }
  if (!process.env.YII_SOURCE_ROOT) throw new Error('Set YII_SOURCE_ROOT to the current Yii game checkout or its api directory.');
  const sourceRoot = realpathSync(resolve(process.env.YII_SOURCE_ROOT));
  const api = existsSync(join(sourceRoot, 'api/components/AdminTokenService.php')) ? join(sourceRoot, 'api') : sourceRoot;
  if (!existsSync(join(api, 'components/AdminTokenService.php')) || !existsSync(join(api, 'vendor/autoload.php'))) {
    throw new Error('YII_SOURCE_ROOT must contain the current Yii backend and installed Composer dependencies.');
  }
  // The generated signing keys only exist in memory and the child process stdin.
  const keys = generateKeyPairSync('ec', { namedCurve:'prime256v1', privateKeyEncoding:{type:'pkcs8',format:'pem'}, publicKeyEncoding:{type:'spki',format:'pem'} });
  const issuer = 'https://interop-' + randomBytes(16).toString('hex') + '.example';
  const redisOptions = { host, port, database:15, password:process.env.ADMIN_AUTH_REDIS_PASSWORD || '', timeout:1500 };
  const redis = new LegacyRedis(redisOptions), store = new AdminTokenStore(redis);
  const tokens = new AdminTokens(store, { issuer, privateKey:keys.privateKey, publicKey:keys.publicKey });
  const identity = {source:'password',username:'isolated-interop',credentialFingerprint:'a'.repeat(64)};
  const families = new Set();
  function remember(pair) { families.add(pair.refreshToken.slice(0, 32)); return pair; }
  function php(input) {
    const result = spawnSync(process.env.PHP_BINARY || 'php', [join(__dirname, 'verify-yii-admin-interop.php')], {
      input:JSON.stringify({...input,test:true,sourceRoot,redis:redisOptions,issuer,private:keys.privateKey,public:keys.publicKey}), encoding:'utf8', timeout:10000,
    });
    if (result.status !== 0) throw new Error('Yii compatibility check failed. Verify the PHP runtime, Composer dependencies and isolated Redis configuration.');
    return JSON.parse(result.stdout);
  }
  async function rejected(operation) {
    try { await operation(); throw new Error('Expected a revoked or spent credential to be rejected.'); }
    catch (error) { assert.equal(error.status, 401); }
  }
  try {
    const nodeIssued = remember(await tokens.issue(identity));
    const phpRefreshed = php({action:'refresh',access:nodeIssued.accessToken,refresh:nodeIssued.refreshToken});
    assert.deepEqual(phpRefreshed.identity, identity);
    assert.deepEqual(await tokens.identity('Bearer ' + phpRefreshed.next.token.accessToken), identity);
    await rejected(() => tokens.refresh(nodeIssued.refreshToken));
    const nodeRefreshed = await tokens.refresh(phpRefreshed.next.token.refreshToken);
    assert.equal(nodeRefreshed.token.refreshExpires, phpRefreshed.next.token.refreshExpires);
    assert.deepEqual(php({action:'validate',access:nodeRefreshed.token.accessToken}).identity, identity);
    assert.equal(php({action:'revoke',access:phpRefreshed.next.token.accessToken,refresh:phpRefreshed.next.token.refreshToken}).revoked, true);
    await rejected(() => tokens.identity('Bearer ' + nodeRefreshed.token.accessToken));
    await rejected(() => tokens.refresh(nodeRefreshed.token.refreshToken));
    const phpIssued = remember(php({action:'issue',identity}).token);
    assert.deepEqual(await tokens.identity('Bearer ' + phpIssued.accessToken), identity);
    const refreshed = await tokens.refresh(phpIssued.refreshToken);
    assert.deepEqual(php({action:'validate',access:refreshed.token.accessToken}).identity, identity);
    await tokens.revoke('Bearer ' + refreshed.token.accessToken);
    await rejected(() => tokens.refresh(refreshed.token.refreshToken));
    console.log('PASS: Yii and Node ES256 issue, identity validation, one-use refresh and immediate revocation interoperate on isolated Redis DB 15; absolute deadlines are preserved.');
  } finally {
    // Remove only this run's random-issuer families, including on partial failure.
    try { for (const sid of families) await store.revoke(sid, null, issuer); }
    finally { await redis.close(); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
