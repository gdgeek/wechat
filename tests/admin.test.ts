import { describe, expect, it } from 'vitest';
import { SceneCatalog, sceneBaseUrl } from '../src/admin/scenes';
import { normalizeDevice, validateConfiguration } from '../src/admin/devices';

describe('scene catalog contract', () => {
  it('accepts approved HTTPS and internal Y1 roots and rejects credentials or arbitrary HTTP', () => {
    expect(sceneBaseUrl('http://y1-p:8080/')).toBe('http://y1-p:8080/v1/server');
    expect(sceneBaseUrl('https://example.com/v1/server/')).toBe('https://example.com/v1/server');
    for (const bad of ['http://localhost:8080', 'https://a:b@example.com', 'https://example.com/other', 'https://example.com/?x=1']) expect(() => sceneBaseUrl(bad)).toThrow();
  });
  it('collects all pages then normalizes verse_id, skips invalid rows and caches the result', async () => {
    const urls: string[] = [];
    const catalog = new SceneCatalog({ baseUrl: 'https://scene.example', perPage: 1, fetch: async (input) => {
      const url = String(input); urls.push(url);
      return new Response(JSON.stringify([{ verse_id: urls.length, name: 'scene' }]), { headers: { 'x-pagination-total-count': '2', 'x-pagination-per-page': '1' } });
    } });
    expect(await catalog.getGames()).toHaveLength(2);
    await catalog.getGames();
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]).searchParams.get('page')).toBe('2');
  });
  it('fails closed on inconsistent metadata or no valid scene rows', async () => {
    for (const headers of [{ 'x-pagination-total-count': '3', 'x-pagination-per-page': '2', 'x-pagination-page-count': '1' }, {}]) {
      const catalog = new SceneCatalog({ fetch: async () => new Response(JSON.stringify([{ id: 5, name: 'wrong id field' }]), { headers }) });
      await expect(catalog.getGames()).rejects.toMatchObject({ status: 503 });
    }
  });
  it('forwards the public scene endpoint as a single cached payload without unwrapping', async () => {
    const urls: string[] = [];
    const catalog = new SceneCatalog({ fetch: async input => { urls.push(String(input)); return new Response(JSON.stringify({ data: [{ verse_id: 3, name: 'Test' }] })); } });
    const ctx: any = { res: { status() { return this; }, type() { return this; } } };
    expect(await catalog.forwardCheckin(ctx)).toEqual({ data: [{ verse_id: 3, name: 'Test' }] });
    await catalog.forwardCheckin(ctx);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.has('page')).toBe(false);
  });
});
describe('device configuration contract', () => {
  it('trims string arrays and accepts clearing without accepting object-shaped lists', () => {
    expect(validateConfiguration({ title: ' name ', slogans: [' one ', '', '  '], pictures: [] })).toEqual({ title: 'name', slogans: ['one'], pictures: [] });
    for (const patch of [[], {}, { slogans: {} }, { title: 1 }, { gameId: '1' }, { money: 5 }]) expect(() => validateConfiguration(patch)).toThrow();
  });
  it('uses device tag/uuid fallback, does not invent heartbeat, preserves blank raw title', () => {
    expect(normalizeDevice({ id: 1, uuid: 'u1', tag: 'A', updated_at: 'now' }, { title: '未知', scene_id: null, slogans: [' x '] })).toMatchObject({ id: 1, name: 'A', title: '未知', status: 'unknown', gameId: null, slogans: ['x'] });
  });
});
