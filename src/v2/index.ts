import type { Context, Row, Services } from '../core/contracts';
import type { ApiRouter } from '../core/router';
import { ApiError } from '../core/errors';
import { absoluteLocation, bodyDeviceId, controlledDevice, controlledSetup, denyAdministration, paginate, saveResource, serialize, validate } from './resources';
import { getInfo, log, refresh } from './server';

export function registerV2(router: ApiRouter, s: Services): void {
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
    const data = await validate(s, 'setup', { ...ctx.body, device_id: deviceId });
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
    await bearer(ctx);
    if (ctx.query.unionid === undefined) throw new ApiError(400, 'Missing required parameters: unionid');
    if (typeof ctx.query.unionid !== 'string') throw new ApiError(400, 'unionid must be a string');
    // Returning getModels() rather than the provider omits pagination headers.
    return paginate(s, ctx, 'file', undefined, false, { where: ctx.query.unionid === '' ? [] : ['unionid LIKE ?'], params: ctx.query.unionid === '' ? [] : [`%${ctx.query.unionid}%`], headers: false });
  });
  router.add('GET', '/v2/files', async ctx => { await bearer(ctx); return paginate(s, ctx, 'file'); });
  router.add('POST', '/v2/files', async ctx => {
    await bearer(ctx);
    const saved = await saveResource(s, 'file', await validate(s, 'file', ctx.body));
    ctx.res.status(201); ctx.res.setHeader('Location', absoluteLocation(ctx, `/v2/files/${saved.id}`));
    return serialize(s, 'file', saved, ctx.query);
  });
  const findFile = async (ctx: Context): Promise<Row> => {
    await bearer(ctx);
    const row = await s.db.one('SELECT * FROM file WHERE id = ?', [ctx.params.id]);
    if (!row) throw new ApiError(404, 'Object not found.');
    return row;
  };
  router.add('GET', '/v2/files/:id', async ctx => serialize(s, 'file', await findFile(ctx), ctx.query));
  router.add(['PUT', 'PATCH'], '/v2/files/:id', async ctx => {
    const row = await findFile(ctx);
    const data = await validate(s, 'file', ctx.body, row);
    return serialize(s, 'file', await saveResource(s, 'file', data, row), ctx.query);
  });

  for (const [path, field] of [['device', 'uuid'], ['applet', 'id'], ['file', 'key']]) router.add('POST', `/v2/server/${path}`, async ctx => {
    if (ctx.body[field] === undefined || ctx.body[field] === null) throw new ApiError(400, `${field} is required`);
    return refresh(s, ctx);
  });
  router.add(['GET', 'POST'], '/v2/server/refresh', ctx => refresh(s, ctx));
  router.add('POST', '/v2/applet/refresh', async ctx => refresh(s, ctx, await bearer(ctx)));
  router.add('GET', '/v2/server/info', async ctx => {
    if (ctx.query.uuid === undefined) throw new ApiError(400, 'Missing required parameters: uuid');
    return { success: true, message: 'success', data: await getInfo(s, ctx.query.uuid) };
  });
  router.add('GET', '/v2/server/log', ctx => log(s, ctx.query.token));
  router.add('GET', '/v2/server/scenes', ctx => s.catalog.forwardCheckin(ctx));
  router.add('GET', '/v2/server/test', () => '2');
}
