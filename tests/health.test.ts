import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { createRouter } from '../src/application';
import { Integrations } from '../src/integrations/integrations';
import { LegacyRedis } from '../src/core/redis';
import type { Services } from '../src/core/contracts';

function fixture(ping: () => Promise<unknown> = async () => 'PONG', query: () => Promise<unknown> = async () => []) {
  const services = { db: { query }, redis: { ping }, auth: {}, catalog: {}, integrations: new Integrations() } as unknown as Services;
  const headers: Record<string, unknown> = {};
  const res = { statusCode: 200, status(value: number) { this.statusCode = value; return this; }, setHeader(name: string, value: unknown) { headers[name] = value; } };
  const health = () => createRouter(services).match('GET', '/health')!.route.handler({ res } as any) as Promise<any>;
  return { health, res, headers };
}

describe('Yii health contract', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  it('uses Shanghai ISO time to seconds and preserves actual Node build metadata', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T18:03:04.567Z'));
    vi.stubEnv('GIT_COMMIT', 'node-build-commit');
    vi.stubEnv('BUILD_TIME', '2026-10-22T17:59:00Z');
    const f = fixture();
    expect(await f.health()).toMatchObject({ status: 'healthy', timestamp: '2026-10-23T02:03:04+08:00', gitCommit: 'node-build-commit', version: '2026-10-23 01:59:00' });
    expect(f.headers['Cache-Control']).toBe('no-store');
  });
  it.each(['2026-10-22 17:59:00', 'custom-build-label'])('preserves build metadata already in the legacy format or a non-date label: %s', async version => {
    vi.stubEnv('BUILD_TIME', version);
    expect((await fixture().health()).version).toBe(version);
  });
  it.each(['PONG', true])('accepts the Yii PING success response %s', async reply => {
    expect((await fixture(async () => reply).health()).checks.redis.status).toBe('up');
  });
  it.each(['NOT-PONG', false, null])('reports unexpected PING response %s as unhealthy', async reply => {
    const f = fixture(async () => reply);
    expect(await f.health()).toMatchObject({ status: 'unhealthy', checks: { redis: { status: 'down', error: 'Unexpected PING response', responseTime: expect.any(Number) } } });
    expect(f.res.statusCode).toBe(503);
  });
  it('sanitizes dependency errors while preserving individual service status', async () => {
    const f = fixture(async () => { throw new Error('Redis password=secret'); });
    expect(await f.health()).toMatchObject({ status: 'unhealthy', checks: { database: { status: 'up' }, redis: { status: 'down', error: 'Service unavailable' } } });
    expect(f.res.statusCode).toBe(503);
  });
  it('bounds health Redis reads after a connection has been established', async () => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      socket.on('data', data => {
        // node-redis setup sends CLIENT SETINFO twice; answer those but leave PING unanswered.
        const count = data.toString().match(/\r\nCLIENT\r\n/gi)?.length ?? 0;
        if (count) socket.write('+OK\r\n'.repeat(count));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const redis = new LegacyRedis({ host: '127.0.0.1', port: (server.address() as any).port });
    try {
      await redis.connect();
      const started = performance.now();
      const result = await Promise.race([redis.ping().then(() => 'unexpected success', () => 'timed out'), new Promise(resolve => setTimeout(() => resolve('hung'), 4000))]);
      expect(result).toBe('timed out');
      expect(performance.now() - started).toBeLessThan(3800);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 6000);
  it('bounds a connection that accepts TCP but never finishes the Redis handshake', async () => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const redis = new LegacyRedis({ host: '127.0.0.1', port: (server.address() as any).port, timeout: 50 });
    try {
      const result = await Promise.race([redis.connect().then(() => 'unexpected success', () => 'timed out'), new Promise(resolve => setTimeout(() => resolve('hung'), 200))]);
      expect(result).toBe('timed out');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
