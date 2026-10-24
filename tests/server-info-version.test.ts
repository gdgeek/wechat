import { describe, expect, it, vi } from 'vitest';
import type { Context, Handler, Row, Services } from '../src/core/contracts';
import { registerV2 } from '../src/v2';
import { getInfo } from '../src/v2/server';

class InfoMemoryDb {
  tables: Record<string, Row[]>;
  reads: string[] = [];
  writes: { method: string; table?: string; sql?: string; params?: unknown[] }[] = [];

  constructor(seed: Record<string, Row[]> = {}) {
    this.tables = structuredClone({ device: [], setup: [], ...seed });
  }

  async one(sql: string, params: unknown[] = []) {
    this.reads.push(sql);
    if (sql === 'SELECT * FROM device WHERE uuid = ?') return structuredClone(this.tables.device.find(row => row.uuid === params[0]) ?? null);
    if (sql === 'SELECT * FROM setup WHERE device_id = ?') return structuredClone(this.tables.setup.find(row => row.device_id === params[0]) ?? null);
    throw new Error(`Unsupported SQL: ${sql}`);
  }

  async insert(table: string, data: Row) {
    this.writes.push({ method: 'insert', table });
    const row = { id: Math.max(0, ...this.tables[table].map(value => Number(value.id))) + 1, ...structuredClone(data) };
    this.tables[table].push(row);
    return structuredClone(row);
  }

  async update(table: string, id: unknown, data: Row) {
    this.writes.push({ method: 'update', table });
    const row = this.tables[table].find(value => value.id === id)!;
    Object.assign(row, structuredClone(data), { updated_at: 'changed-by-timestamp-behavior' });
    return structuredClone(row);
  }

  async execute(sql: string, params: unknown[]) {
    this.writes.push({ method: 'execute', sql, params: structuredClone(params) });
    if (sql !== 'UPDATE device SET version = ? WHERE id = ?') throw new Error(`Unsupported SQL: ${sql}`);
    const row = this.tables.device.find(value => value.id === params[1]);
    if (row) row.version = params[0];
    return { affectedRows: row ? 1 : 0, insertId: 0 };
  }

  async transaction<T>(operation: (db: InfoMemoryDb) => Promise<T>) {
    const before = structuredClone(this.tables);
    try { return await operation(this); }
    catch (error) { this.tables = before; throw error; }
  }
}

function fixture(version?: number | string) {
  const db = new InfoMemoryDb(version === undefined ? {} : {
    device: [{ id: 7, uuid: 'configured', version, tag: '保留标签', ip: '127.0.0.2', created_at: '2026-10-21 10:00:00', updated_at: '2026-10-22 10:00:00' }],
    setup: [{ id: 9, device_id: 7, title: '保留标题', pictures: ['keep.png'], scene_id: 700, money: 9.9, slogans: ['保留口号'], thumbs: ['keep.webp'], shots: [1, 5], updated_at: '2026-10-22 11:00:00' }],
  });
  const catalog = { getGames: vi.fn(async () => [{ id: 638, name: '测试场景' }]) };
  const services = { db, catalog } as unknown as Services;
  const routes = new Map<string, Handler>();
  registerV2({ add(methods: string | string[], path: string, handler: Handler) {
    for (const method of typeof methods === 'string' ? [methods] : methods) routes.set(`${method} ${path}`, handler);
  } } as any, services);
  async function request(query: Row) {
    return routes.get('GET /v2/server/info')!({ query } as Context) as Promise<Row>;
  }
  return { db, catalog, services, request };
}

const retainedInfo = { title: '保留标题', pictures: ['keep.png'], scene_id: 700, updated_at: '2026-10-22 11:00:00' };

describe('GET /v2/server/info device version contract', () => {
  it.each([
    ['explicit version', { version: '2' }, 2],
    ['omitted version', {}, 0],
    ['model default version', { version: '1' }, 1],
  ])('initializes a new UUID with %s and its complete default configuration', async (_name, query, version) => {
    const f = fixture();
    const response = await f.request({ uuid: 'new-device', ...query });
    expect(response).toEqual({ success: true, message: 'success', data: {
      title: '未知',
      pictures: [1, 2, 3, 4].map(index => `https://game-1251022382.cos.ap-nanjing.myqcloud.com/picture/t${index}.png`),
      scene_id: 638,
      updated_at: expect.any(String),
    } });
    expect(f.db.tables.device).toHaveLength(1);
    expect(f.db.tables.device[0]).toMatchObject({ uuid: 'new-device', version });
    expect(f.db.tables.setup).toEqual([expect.objectContaining({
      device_id: 1, money: 0, shots: [1, 5, 10, 20],
      slogans: ['我在这里很想你', '今天也要加油鸭', '阳光正好，微风不燥', '记录每一刻，热爱每一天'],
      thumbs: [1, 2, 3, 4].map(index => `https://game-1251022382.cos.ap-nanjing.myqcloud.com/picture/t${index}.webp`),
    })]);
    expect(f.db.writes.filter(write => write.method === 'execute')).toEqual(version === 1 ? [] : [
      { method: 'execute', sql: 'UPDATE device SET version = ? WHERE id = ?', params: [version, 1] },
    ]);
  });

  it.each([
    ['upgrade', 1, '2', 2],
    ['downgrade', 8, '2', 2],
    ['explicit zero', 8, '0', 0],
    ['maximum string', 2, '2147483647', 2147483647],
    ['maximum integer', 2, 2147483647, 2147483647],
    ['integer', 9, 2, 2],
    ['signed string', 9, '+2', 2],
    ['whitespace', 9, '\t\n\v\r +2 \r\v\n\t', 2],
    ['signed zero', 9, '-0', 0],
  ])('accepts the PHP integer form for %s without altering timestamps or configuration', async (_name, initial, reported, expected) => {
    const f = fixture(initial);
    const before = structuredClone(f.db.tables);
    f.catalog.getGames.mockRejectedValue(new Error('An existing configuration must not fetch defaults'));
    expect(await f.request({ uuid: 'configured', version: reported })).toEqual({ success: true, message: 'success', data: retainedInfo });
    expect(f.db.tables).toEqual({ ...before, device: [{ ...before.device[0], version: expected }] });
    expect(f.db.writes).toEqual([{ method: 'execute', sql: 'UPDATE device SET version = ? WHERE id = ?', params: [expected, 7] }]);
    expect(f.catalog.getGames).not.toHaveBeenCalled();
  });

  it('resets an existing device to zero when the query version is omitted', async () => {
    const f = fixture(9);
    await f.request({ uuid: 'configured' });
    expect(f.db.tables.device[0]).toMatchObject({ version: 0, updated_at: '2026-10-22 10:00:00' });
    expect(f.db.writes).toEqual([{ method: 'execute', sql: 'UPDATE device SET version = ? WHERE id = ?', params: [0, 7] }]);
  });

  it.each([
    [2, { version: '2' }],
    ['2', { version: '2' }],
    [0, {}],
  ])('avoids every device/setup write when persisted version %s is unchanged', async (initial, query) => {
    const f = fixture(initial);
    const before = structuredClone(f.db.tables);
    expect(await f.request({ uuid: 'configured', ...query })).toEqual({ success: true, message: 'success', data: retainedInfo });
    expect(f.db.tables).toEqual(before);
    expect(f.db.writes).toEqual([]);
  });

  it.each([
    -1, '-1', 1.5, '1.5', 'invalid', '', [], ['2'], {}, null, undefined, true, false,
    2147483648, '2147483648', '00', '02', '2e0', '2.0', '0x2', ' ', '\f2\f', '2\0',
  ].map(version => [version]))('rejects invalid version %j before reading storage or fetching defaults', async version => {
    const f = fixture(9);
    const before = structuredClone(f.db.tables);
    for (const uuid of ['new-device', 'configured']) {
      await expect(f.request({ uuid, version })).rejects.toMatchObject({ status: 400, message: 'version must be an integer between 0 and 2147483647' });
      expect(f.db.tables).toEqual(before);
      expect(f.db.reads).toEqual([]);
      expect(f.db.writes).toEqual([]);
      expect(f.catalog.getGames).not.toHaveBeenCalled();
    }
  });

  it('preserves the required UUID binding error before version validation', async () => {
    const f = fixture();
    await expect(f.request({ version: 'invalid' })).rejects.toMatchObject({ status: 400, message: 'Missing required parameters: uuid' });
    expect(f.db.reads).toEqual([]);
    expect(f.db.writes).toEqual([]);
    expect(f.catalog.getGames).not.toHaveBeenCalled();
  });

  it.each(['', '0'])('returns default info for empty UUID %j without persistence', async uuid => {
    const f = fixture();
    expect(await f.request({ uuid, version: '2' })).toMatchObject({ success: true, data: { title: '未知', scene_id: 638 } });
    expect(f.db.tables).toEqual({ device: [], setup: [] });
    expect(f.db.writes).toEqual([]);
  });

  it('leaves no partial device or configuration when fetching the initial catalog fails', async () => {
    const f = fixture();
    f.catalog.getGames.mockRejectedValue(Object.assign(new Error('Upstream unavailable'), { status: 503 }));
    await expect(f.request({ uuid: 'new-device', version: '2' })).rejects.toMatchObject({ status: 503 });
    expect(f.db.tables).toEqual({ device: [], setup: [] });
    expect(f.db.writes).toEqual([]);
  });
});

describe('internal getInfo device version contract', () => {
  it('preserves an existing version when called without a reported version', async () => {
    const f = fixture(9);
    const before = structuredClone(f.db.tables);
    expect(await getInfo(f.services, 'configured')).toEqual(retainedInfo);
    expect(f.db.tables).toEqual(before);
    expect(f.db.writes).toEqual([]);
  });

  it('synchronizes an explicitly provided validated version without changing updated_at', async () => {
    const f = fixture(9);
    expect(await getInfo(f.services, 'configured', 2)).toEqual(retainedInfo);
    expect(f.db.tables.device[0]).toMatchObject({ version: 2, updated_at: '2026-10-22 10:00:00' });
    expect(f.db.writes).toEqual([{ method: 'execute', sql: 'UPDATE device SET version = ? WHERE id = ?', params: [2, 7] }]);
  });

  it('keeps the model default version for a new UUID when no version was reported', async () => {
    const f = fixture();
    await getInfo(f.services, 'internal-new');
    expect(f.db.tables.device[0].version).toBe(1);
    expect(f.db.writes.filter(write => write.method !== 'insert')).toEqual([]);
  });
});
