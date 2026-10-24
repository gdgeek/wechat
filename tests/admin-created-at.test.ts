import { describe, expect, it } from 'vitest';
import { AdminDevices, normalizeDevice } from '../src/admin/devices';
import type { Row, Services } from '../src/core/contracts';

describe('administrator device timestamps match Yii', () => {
  it('takes createdAt from the device even when the setup was created later', () => {
    expect(normalizeDevice(
      { id: 1, created_at: '2026-10-01 09:00:00' },
      { created_at: '2026-10-20 09:00:00' },
    ).createdAt).toBe('2026-10-01 09:00:00');
  });

  it.each([null, undefined])('returns an empty createdAt for a %s device creation timestamp', createdAt => {
    const device: Row = { id: 1 };
    if (createdAt !== undefined) device.created_at = createdAt;
    expect(normalizeDevice(device, { created_at: '2026-10-20 09:00:00' }).createdAt).toBe('');
  });

  it('serializes a device creation timestamp as a string', () => {
    expect(normalizeDevice({ id: 1, created_at: 123 }, null).createdAt).toBe('123');
  });

  it('keeps setup updatedAt priority even when the device update is newer', () => {
    expect(normalizeDevice(
      { id: 1, created_at: '2026-10-01 09:00:00', updated_at: '2026-10-23 09:00:00' },
      { created_at: '2026-10-20 09:00:00', updated_at: '2026-10-21 09:00:00' },
    ).updatedAt).toBe('2026-10-21 09:00:00');
  });

  it.each([null, {}, { updated_at: null }, { updated_at: '' }])('falls back to the device updatedAt when setup has no update (%j)', setup => {
    expect(normalizeDevice({ id: 1, updated_at: '2026-10-23 09:00:00' }, setup).updatedAt).toBe('2026-10-23 09:00:00');
  });

  it('returns an empty updatedAt when both timestamps are missing', () => {
    expect(normalizeDevice({ id: 1 }, null).updatedAt).toBe('');
  });

  it.each(['list', 'update'] as const)('includes createdAt in the %s service response', async operation => {
    const device = { id: 1, uuid: 'device-1', created_at: '2026-10-01 09:00:00', updated_at: '2026-10-23 09:00:00' };
    let setup = { id: 2, device_id: 1, title: 'Device', created_at: '2026-10-20 09:00:00', updated_at: '2026-10-21 09:00:00' };
    const db = {
      query: async () => [device],
      one: async (sql: string) => sql.includes('FROM device') ? device : setup,
      update: async (_table: string, _id: unknown, patch: Row) => (setup = { ...setup, ...patch }),
      transaction: async (operation: (database: unknown) => Promise<Row>) => operation(db),
    };
    const devices = new AdminDevices({ db } as unknown as Services);

    if (operation === 'list') {
      expect(await devices.list(null)).toMatchObject([{ createdAt: device.created_at, updatedAt: setup.updated_at }]);
    } else {
      expect(await devices.update(1, { title: 'Renamed' }, null)).toMatchObject({ title: 'Renamed', createdAt: device.created_at, updatedAt: setup.updated_at });
    }
  });
});
