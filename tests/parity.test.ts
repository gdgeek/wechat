import { describe, expect, it } from 'vitest';
import { createRouter, createServices } from '../src/application';
import { ApiRouter } from '../src/core/router';
import { auditRoutes, loadSnapshot, validateSnapshot, validateSourceCheckout } from '../scripts/check-parity';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('source-derived HTTP route parity', () => {
  it('checks actual source files and detects changed, missing and newly added backend code', () => {
    const root = mkdtempSync(join(tmpdir(), 'wechat-source-freshness-'));
    try {
      mkdirSync(join(root, 'api/components'), { recursive: true });
      const file = 'api/components/Source.php', source = '<?php // source';
      writeFileSync(join(root, file), source);
      const manifest = { files: { [file]: createHash('sha256').update(source).digest('hex') }, sourceScope: ['api/components'] };
      expect(validateSourceCheckout(root, manifest)).toEqual([]);
      writeFileSync(join(root, file), '<?php // changed');
      expect(validateSourceCheckout(root, manifest)).toContain(`Source changed: ${file}`);
      writeFileSync(join(root, 'api/components/New.php'), '<?php // newly added');
      expect(validateSourceCheckout(root, manifest)).toContain('Source not captured: api/components/New.php');
      unlinkSync(join(root, file));
      expect(validateSourceCheckout(root, manifest)).toContain(`Source missing: ${file}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('retains independent source declarations, missing actions and Yii inherited REST rules', () => {
    const snapshot = loadSnapshot();
    expect(snapshot.summary).toMatchObject({ declaredMethodPaths: 488, resolvable: 249, businessAndRest: 183, optionsFallbacks: 66, missingAction: 223, missingController: 16 });
    expect(snapshot.routes.find(row => row.method === 'GET' && row.path === '/v1/manager/login')).toMatchObject({ sourceStatus: 'missing-controller' });
    expect(snapshot.routes.find(row => row.method === 'GET' && row.path === '/v1/system/ready')).toMatchObject({ sourceStatus: 'missing-action' });
    expect(snapshot.routes.find(row => row.method === 'GET' && row.path === '/v2/wechat/info')).toMatchObject({ sourceStatus: 'missing-action' });
    expect(snapshot.routes.find(row => row.method === 'PUT' && row.path === '/v1/record/{id}')).toMatchObject({ sourceStatus: 'resolvable', inheritedRestAction: true, yiiRoute: 'v1/record/update' });
    expect(snapshot.routes.find(row => row.method === 'POST' && row.path === '/v1/device/{id}')).toMatchObject({ sourceStatus: 'resolvable', action: 'options', sourceAnyVerbFallback: true });
    expect(snapshot.routes.filter(row => row.sampleMatchesSource === false)).toEqual([]);
    expect(validateSnapshot(snapshot)).toEqual([]);
  });

  it('covers every source-resolvable route in the actual application registration table', async () => {
    const services = createServices();
    try {
      const audit = auditRoutes(loadSnapshot(), createRouter(services));
      expect(audit.missing, 'A missing source route must be implemented or reported; never remove it from the source snapshot.').toEqual([]);
      expect(audit.unexplainedExtras).toEqual([]);
      expect(audit.unexpected404Changes).toEqual([]);
      expect(audit.covered).toHaveLength(249);
      expect(audit.preserved404).toHaveLength(239);
      // Source UrlRule declares delete, but FileController removes the action.
      // Probe the registered preservation without issuing database/provider I/O.
      const preserved = createRouter(services).match('DELETE', '/v2/files/1');
      expect(preserved).not.toBeNull();
      await expect(Promise.resolve().then(() => preserved!.route.handler({ req: { headers: {} }, res: {}, body: {}, query: {}, params: { id: '1' } } as any))).rejects.toMatchObject({ status: 404 });
    } finally { await services.db.close(); await services.redis.close(); }
  });

  it('fails closed when a real inherited REST route disappears', () => {
    const snapshot = loadSnapshot();
    const router = new ApiRouter();
    const audit = auditRoutes(snapshot, router);
    expect(audit.missing.some(row => row.method === 'PUT' && row.path === '/v1/record/{id}')).toBe(true);
    expect(audit.missing.some(row => row.path === '/v1/manager/login')).toBe(false);
    expect(audit.covered).toEqual([]);
  });

  it('keeps representative undeclared HEAD methods at source 404 without OptionsAction fallback', async () => {
    const snapshot = loadSnapshot();
    expect(snapshot.unconfiguredVerbCases.map(row => row.path)).toEqual(['/admin-api/session', '/v1/common/test', '/v1/game/ready', '/v2/server/info', '/v2/files/list']);
    const services = createServices();
    try {
      const router = createRouter(services);
      for (const row of snapshot.unconfiguredVerbCases) {
        expect(row).toMatchObject({ method: 'HEAD', sourceStatus: 'unconfigured-404', matchedSourceRules: [] });
        expect(router.match('HEAD', row.sample), row.path).toBeNull();
        expect(router.match('OPTIONS', row.sample), `${row.path} must not reach OptionsAction`).toBeNull();
      }
      for (const path of ['/health', '/v1/record', '/v1/record/1', '/v2/files', '/v2/files/1']) expect(router.match('HEAD', path)?.route.method).toBe('HEAD');
      const audit = auditRoutes(snapshot, router);
      expect(audit.negativeCasesCovered).toHaveLength(7);
      expect(audit.unexpectedVerbChanges).toEqual([]);
    } finally { await services.db.close(); await services.redis.close(); }
  });

  it('does not publish missing or unrouted v2 WeChat actions', async () => {
    const snapshot = loadSnapshot();
    expect(snapshot.notFoundProbes.map(row => [row.method, row.path, row.sourceStatus])).toEqual([
      ['GET', '/v2/wechat/info', 'missing-action'],
      ['GET', '/v2/wechat/code', 'unrouted-action'],
    ]);
    const services = createServices();
    try {
      const router = createRouter(services);
      for (const row of snapshot.notFoundProbes) {
        expect(router.match(row.method, row.sample), row.path).toBeNull();
        expect(router.match('OPTIONS', row.sample), row.path).toBeNull();
      }
    } finally { await services.db.close(); await services.redis.close(); }
  });

  it('detects invented APIs while allowing explicitly documented source repairs', () => {
    const snapshot = loadSnapshot();
    const router = new ApiRouter();
    router.add('GET', '/v1/system/ready', () => null);
    router.add('GET', '/invented-api', () => null);
    router.add('GET', '/v2/wechat/info', () => null);
    router.add('GET', '/v2/wechat/code', () => null);
    router.add('GET', '/v1/q-cloud/object-url', () => null);
    router.add('HEAD', '/admin-api/session', () => null);
    const audit = auditRoutes(snapshot, router);
    expect(audit.unexpected404Changes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/v1/system/ready' }));
    expect(audit.unexplainedExtras).toContainEqual(expect.objectContaining({ method: 'GET', path: '/invented-api' }));
    expect(audit.unexpected404Changes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/v2/wechat/info' }));
    expect(audit.unexplainedExtras).toContainEqual(expect.objectContaining({ method: 'GET', path: '/v2/wechat/code' }));
    expect(audit.documentedAdaptations).toContainEqual(expect.objectContaining({ method: 'GET', path: '/v1/q-cloud/object-url' }));
    expect(audit.unexpectedVerbChanges).toContainEqual(expect.objectContaining({ method: 'HEAD', path: '/admin-api/session' }));
  });
});
