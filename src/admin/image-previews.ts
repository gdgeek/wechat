import type { Row } from '../core/contracts';
import { ApiError } from '../core/errors';
import type { Integrations } from '../integrations/integrations';
import type { AdminDevices } from './devices';

const bucketPattern = /^[a-z0-9][a-z0-9-]*-[1-9][0-9]*$/;
const regionPattern = /^[a-z]+(?:-[a-z0-9]+)+$/;
const hostPattern = /^[a-z0-9][a-z0-9-]*-[1-9][0-9]*\.cos\.[a-z]+(?:-[a-z0-9]+)+\.myqcloud\.com$/;

function cosObject(source: string): { source: string; host: string; key: string } | null {
  if (/[\x00-\x20\x7f\\]/.test(source)) return null;
  // Inspect the saved path before URL parsing can normalize dot segments or ports.
  const parts = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/i.exec(source);
  if (!parts || !hostPattern.test(parts[1].toLowerCase())) return null;
  const path = parts[2] ?? '';
  if (!path || /%(?![a-f0-9]{2})/i.test(path)) return null;
  let key: string;
  try { key = decodeURIComponent(path.slice(1)); } catch { return null; }
  if (!key || /[\x00-\x1f\x7f\\]/.test(key) || key.split('/').some(part => part === '.' || part === '..')) return null;
  return { source, host: parts[1].toLowerCase(), key };
}

export class AdminImagePreviews {
  constructor(private readonly devices: AdminDevices, private readonly integrations: Integrations) {}
  async get(id: number, userId: number | null): Promise<Row[]> {
    const sources = await this.devices.imageSources(id, userId);
    const candidates = sources.map(cosObject).filter(object => object !== null);
    if (!candidates.length) return [];
    try {
      const { bucket, region, secretId, secretKey } = this.integrations.config;
      if (typeof bucket !== 'string' || !bucketPattern.test(bucket) || typeof region !== 'string' || !regionPattern.test(region)) throw Error('Unavailable COS configuration');
      const objects = candidates.filter(object => object.host === `${bucket}.cos.${region}.myqcloud.com`);
      if (!objects.length) return [];
      if (typeof secretId !== 'string' || !secretId.trim() || typeof secretKey !== 'string' || !secretKey.trim()) throw Error('Unavailable COS credentials');
      const expiresAt = this.integrations.now() + 300;
      return await Promise.all(objects.map(async object => {
        // COS PHP Client::explodeKey removes empty path segments and preserves
        // one trailing slash; keep the saved source itself unchanged.
        let key = object.key.split('/').filter(Boolean).join('/');
        if (!key) throw Error('Unavailable COS object');
        if (object.key.endsWith('/')) key += '/';
        const signed = new URL(await this.integrations.objectUrl(key, { method: 'GET', expires: 300 }, expiresAt));
        // The PHP COS SDK encloses authorization fields in one `sign` parameter.
        signed.search = new URLSearchParams({ sign: signed.search.slice(1) }).toString();
        return { source: object.source, url: signed.toString(), expiresAt };
      }));
    } catch { throw new ApiError(503, '图片预览暂时不可用，请稍后重试', undefined, 'HttpException'); }
  }
}
