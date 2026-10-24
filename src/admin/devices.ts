import type { Row, Services } from '../core/contracts';
import { ApiError } from '../core/errors';
import { defaultData } from '../v2/server';

function content(values: unknown): string[] { return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string' && value.trim() !== '').map(value => value.trim()) : []; }
export function normalizeDevice(device: Row, setup: Row | null): Row {
  const title = String(setup?.title ?? '');
  return { id: Number(device.id), version: Number(device.version ?? 0), uuid: String(device.uuid ?? ''), name: title.trim() && title.trim() !== '未知' ? title.trim() : String(device.tag || device.uuid || `设备 ${device.id}`), title, ip: String(device.ip ?? ''), status: 'unknown', createdAt: String(device.created_at ?? ''), updatedAt: String(setup?.updated_at || device.updated_at || ''), gameId: setup?.scene_id == null ? null : Number(setup.scene_id), slogans: content(setup?.slogans), pictures: content(setup?.pictures), thumbs: content(setup?.thumbs) };
}
export function validateConfiguration(input: unknown): Row {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(422, '设备配置必须为 JSON 对象');
  const patch = { ...input } as Row;
  const allowed = ['gameId', 'title', 'slogans', 'pictures', 'thumbs'];
  if (!Object.keys(patch).length || Object.keys(patch).some(key => !allowed.includes(key))) throw new ApiError(422, '请仅提交需要修改的设备名称、游戏、口号、图片或缩略图');
  if ('gameId' in patch && (!Number.isInteger(patch.gameId) || patch.gameId <= 0)) throw new ApiError(422, 'gameId 必须为有效的游戏编号');
  if ('title' in patch) {
    if (typeof patch.title !== 'string' || [...patch.title.trim()].length > 255) throw new ApiError(422, 'title 必须为不超过 255 个字符的设备名称');
    patch.title = patch.title.trim();
    if (['utf8', 'utf8mb3'].includes((process.env.MYSQL_CHARSET ?? 'utf8mb4').toLowerCase()) && /[\u{10000}-\u{10FFFF}]/u.test(patch.title)) throw new ApiError(422, '设备名称暂不支持表情符号，请使用文字或数字');
  }
  for (const field of ['slogans', 'pictures', 'thumbs']) if (field in patch) {
    if (!Array.isArray(patch[field]) || patch[field].some((value: unknown) => typeof value !== 'string')) throw new ApiError(422, `${field} 必须为字符串列表`);
    patch[field] = content(patch[field]);
  }
  return patch;
}
export class AdminDevices {
  constructor(private readonly services: Services) {}
  async imageSources(id: number, userId: number | null): Promise<string[]> {
    try {
      const where = userId === null ? '' : ' AND id IN (SELECT device_id FROM control WHERE user_id=?)';
      const device = await this.services.db.one(`SELECT * FROM device WHERE id=?${where}`, userId === null ? [id] : [id, userId]);
      if (!device) throw new ApiError(404, '设备不存在');
      const setup = await this.services.db.one('SELECT * FROM setup WHERE device_id=? LIMIT 1', [id]);
      return [...new Set([...content(setup?.pictures), ...content(setup?.thumbs)])];
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, '设备数据暂时不可用，请稍后重试', undefined, 'HttpException'); }
  }
  async list(userId: number | null): Promise<Row[]> {
    try {
      const where = userId === null ? '' : ' WHERE device.id IN (SELECT device_id FROM control WHERE user_id=?)';
      const devices = await this.services.db.query(`SELECT * FROM device${where} ORDER BY id`, userId === null ? [] : [userId]);
      return await Promise.all(devices.map(async device => normalizeDevice(device, await this.services.db.one('SELECT * FROM setup WHERE device_id=? LIMIT 1', [device.id]))));
    } catch { throw new ApiError(503, '设备数据暂时不可用，请稍后重试', undefined, 'HttpException'); }
  }
  async deleteDevice(id: number, userId: number | null): Promise<Row> {
    if (userId !== null) throw new ApiError(403, '仅管理员可以删除设备');
    try {
      return await this.services.db.transaction(async db => {
        const device = await db.one('SELECT * FROM device WHERE id=? FOR UPDATE', [id]);
        if (!device) throw new ApiError(404, '设备不存在');
        const reference = (await db.columns('record')).find(column => column.name === 'device_id');
        if (!reference?.nullable) throw new Error('Record preservation migration is required.');
        const records = await db.query('SELECT id,status FROM record WHERE device_id=? FOR UPDATE', [id]);
        if (records.some(record => record.status !== 'finish')) throw new ApiError(409, '设备仍有未结束的游戏，请先结束游戏后再删除');
        // Bypass model timestamp behavior and detach history even if an old FK still cascades.
        await db.execute('UPDATE record SET device_id=NULL WHERE device_id=?', [id]);
        for (const table of ['setup', 'control', 'manager']) await db.execute(`DELETE FROM ${table} WHERE device_id=?`, [id]);
        const deleted = await db.execute('DELETE FROM device WHERE id=?', [id]);
        if (deleted.affectedRows !== 1) throw new Error('Device deletion did not remove its record.');
        return { id, deleted: true };
      });
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, '设备暂时无法删除，请稍后重试', undefined, 'HttpException'); }
  }
  async update(id: number, input: unknown, userId: number | null): Promise<Row> {
    const patch = validateConfiguration(input);
    if ('gameId' in patch && !(await this.services.catalog.getGames()).some(game => game.id === patch.gameId)) throw new ApiError(422, '请选择游戏列表中的游戏');
    try {
      return await this.services.db.transaction(async db => {
        const where = userId === null ? '' : ' AND id IN (SELECT device_id FROM control WHERE user_id=?)';
        const device = await db.one(`SELECT * FROM device WHERE id=?${where} FOR UPDATE`, userId === null ? [id] : [id, userId]);
        if (!device) throw new ApiError(404, '设备不存在');
        let setup = await db.one('SELECT * FROM setup WHERE device_id=? LIMIT 1', [id]);
        if (!setup) {
          const scene = patch.gameId ?? (await this.services.catalog.getGames())[0]?.id ?? null;
          setup = await db.insert('setup', { ...defaultData(), title: '未知', pictures: [1, 2, 3, 4].map(i => `https://game-1251022382.cos.ap-nanjing.myqcloud.com/picture/t${i}.png`), scene_id: scene, device_id: id });
        }
        const data: Row = {};
        for (const field of ['title', 'slogans', 'pictures', 'thumbs']) if (field in patch) data[field] = patch[field];
        if ('gameId' in patch) data.scene_id = patch.gameId;
        setup = await db.update('setup', setup.id, data);
        return normalizeDevice(device, setup);
      });
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, '设备配置暂时无法保存，请稍后重试', undefined, 'HttpException'); }
  }
}
