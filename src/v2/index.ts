import type { Context, Row, Services } from '../core/contracts';
import type { ApiRouter } from '../core/router';
import { ApiError } from '../core/errors';
import { absoluteLocation, bodyDeviceId, controlledDevice, controlledSetup, denyAdministration, paginate, saveResource, serialize, validate } from './resources';
import { getInfo, log, refresh, reportedVersion } from './server';
import { MiniProgramFileService } from './file-service';

export function registerV2(router: ApiRouter, s: Services): void {
  const files = new MiniProgramFileService(s.db);
  const bearer = (ctx: Context) => s.auth.bearer(ctx, 'v2-user');
  const forbidden = async (ctx: Context) => { await bearer(ctx); denyAdministration(); };
  // Register named paths ahead of :id paths, as Yii's extraPatterns does.
  router.add('GET', '/v2/devices/manage', async ctx => paginate(s, ctx, 'device', await bearer(ctx), true));
  router.add('POST', '/v2/devices/assign', forbidden);
  router.add('POST', '/v2/devices/:device_id/assign', forbidden);
  router.add('DELETE', '/v2/devices/:device_id/assign/:user_id', forbidden);
  router.add('GET', '/v2/devices', async ctx => paginate(s, ctx, 'device', await bearer(ctx)));
  router.add('POST', '/v2/devices', forbidden);
  router.add('GET', '/v2/devices/:id', async ctx => serialize(s, 'device', await controlledDevice(s, await bearer(ctx), ctx.params.id), ctx.query));
  router.add(['PUT', 'PATCH'], '/v2/devices/:id', async ctx => {
    const row = await controlledDevice(s, await bearer(ctx), ctx.params.id);
    const data = await validate(s, 'device', ctx.body, row);
    return serialize(s, 'device', await saveResource(s, 'device', data, row), ctx.query);
  });
  router.add('DELETE', '/v2/devices/:id', forbidden);

  router.add('GET', '/v2/setups', async ctx => paginate(s, ctx, 'setup', await bearer(ctx)));
  router.add('POST', '/v2/setups', async ctx => {
    const user = await bearer(ctx);
    const deviceId = bodyDeviceId(ctx.body.device_id);
    await controlledDevice(s, user, deviceId);
    const data = await validate(s, 'setup', ctx.body);
    const saved = await saveResource(s, 'setup', data);
    ctx.res.status(201); ctx.res.setHeader('Location', absoluteLocation(ctx, `/v2/setups/${saved.id}`));
    return serialize(s, 'setup', saved, ctx.query);
  });
  router.add('GET', '/v2/setups/:id', async ctx => serialize(s, 'setup', await controlledSetup(s, await bearer(ctx), ctx.params.id), ctx.query));
  router.add(['PUT', 'PATCH'], '/v2/setups/:id', async ctx => {
    const row = await controlledSetup(s, await bearer(ctx), ctx.params.id);
    if (Object.hasOwn(ctx.body, 'device_id') && bodyDeviceId(ctx.body.device_id) !== Number(row.device_id)) throw new ApiError(403, '不可将设备配置重新关联到其他设备');
    const data = await validate(s, 'setup', ctx.body, row);
    return serialize(s, 'setup', await saveResource(s, 'setup', data, row), ctx.query);
  });
  router.add('DELETE', '/v2/setups/:id', async ctx => {
    const row = await controlledSetup(s, await bearer(ctx), ctx.params.id);
    await s.db.delete('setup', row.id); ctx.res.status(204); return null;
  });

  router.add('GET', '/v2/files/list', async ctx => {
    const owner = files.ownedQuery(await bearer(ctx));
    const rows = await s.db.query(`SELECT * FROM file WHERE ${owner.where} ORDER BY id DESC`, owner.params);
    return Promise.all(rows.map(row => serialize(s, 'file', row, ctx.query)));
  });
  router.add('GET', '/v2/files', async ctx => {
    const user = await bearer(ctx), owner = files.ownedQuery(user);
    return paginate(s, ctx, 'file', user, false, { where: [owner.where], params: owner.params });
  });
  router.add('GET', '/v2/files/:id', async ctx => serialize(s, 'file', await files.findOwned(ctx.params.id, await bearer(ctx)), ctx.query));
  router.add('POST', '/v2/files', () => { throw new ApiError(404, 'Page not found.'); });
  router.add(['PUT', 'PATCH'], '/v2/files/:id', () => { throw new ApiError(404, 'Page not found.'); });

  for (const [path, field] of [['device', 'uuid'], ['applet', 'id'], ['file', 'key']]) router.add('POST', `/v2/server/${path}`, async ctx => {
    if (ctx.body[field] === undefined || ctx.body[field] === null) throw new ApiError(400, `${field} is required`, undefined, 'HttpException');
    return refresh(s, ctx);
  });
  router.add(['GET', 'POST'], '/v2/server/refresh', ctx => refresh(s, ctx));
  router.add('POST', '/v2/applet/refresh', async ctx => refresh(s, ctx, await bearer(ctx)));
  router.add('GET', '/v2/server/info', async ctx => {
    if (ctx.query.uuid === undefined) throw new ApiError(400, 'Missing required parameters: uuid');
    const version = reportedVersion(ctx.query);
    return { success: true, message: 'success', data: await getInfo(s, ctx.query.uuid, version) };
  });
  router.add('GET', '/v2/server/log', ctx => log(s, ctx.query.token));
  router.add('GET', '/v2/server/scenes', ctx => s.catalog.forwardCheckin(ctx));
  router.add('GET', '/v2/server/test', () => '2');
}
