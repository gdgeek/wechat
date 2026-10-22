import bcrypt from 'bcryptjs';
import type { Services } from '../core/contracts';
import type { ApiRouter } from '../core/router';
import { ApiError } from '../core/errors';
import { AdminDevices } from './devices';
import { BrowserSessions, equal, sha256, throttle } from './sessions';
import { ScanTickets } from './tickets';

export function registerAdmin(router: ApiRouter, s: Services): void {
  const sessions = new BrowserSessions(s.db), tickets = new ScanTickets(s), devices = new AdminDevices(s);
  router.add('GET', '/admin-api/session', ctx => sessions.run(ctx, async state => ({ user: await sessions.user(state), csrfToken: state.csrf, scanLoginEnabled: tickets.enabled() })));
  router.add('POST', '/admin-api/login', ctx => sessions.run(ctx, async state => {
    const { username, password } = ctx.body;
    if (typeof username !== 'string' || typeof password !== 'string' || Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 1024) throw new ApiError(422, '请输入用户名和密码');
    await throttle(s.db, ctx, `login:${ctx.req.ip}`, 5, 60, false);
    const hash = process.env.ADMIN_PASSWORD_HASH || '$2y$12$3RAuTkI52n8qXYippmstTOyJbMslkfdtsRYghaxUSKlKP7g1u8c2.';
    const valid = await bcrypt.compare(password, hash.replace(/^\$2y\$/, '$2b$'));
    if (!equal(username, process.env.ADMIN_USERNAME || 'dirui') || !valid) {
      await throttle(s.db, ctx, `login:${ctx.req.ip}`, 5, 60);
      throw new ApiError(401, '用户名或密码错误');
    }
    await s.db.delete('node_rate_limit', sha256(`login:${ctx.req.ip}`));
    await tickets.cancelCurrent(state);
    state.identity = { source: 'password', username, expiresAt: Math.floor(Date.now() / 1000) + 28800 };
    state.rotate = true;
    return { user: { username, role: 'admin' }, csrfToken: state.csrf };
  }));
  router.add('POST', '/admin-api/logout', ctx => sessions.run(ctx, async state => { await tickets.cancelCurrent(state); delete state.identity; state.rotate = true; return { user: null, csrfToken: state.csrf }; }));
  router.add('GET', '/admin-api/devices', ctx => sessions.run(ctx, async state => devices.list(await sessions.scope(state))));
  router.add('GET', '/admin-api/games', ctx => sessions.run(ctx, async state => { await sessions.scope(state); return s.catalog.getGames(); }));
  router.add('PUT', '/admin-api/devices/:id/game', ctx => sessions.run(ctx, async state => devices.update(Number(ctx.params.id), { gameId: ctx.body.gameId }, await sessions.scope(state))));
  router.add('PUT', '/admin-api/devices/:id/configuration', ctx => sessions.run(ctx, async state => devices.update(Number(ctx.params.id), ctx.body, await sessions.scope(state))));
  router.add('POST', '/admin-api/scan-login/tickets', ctx => sessions.run(ctx, async state => tickets.create(ctx, state)));
  router.add('GET', '/admin-api/scan-login/tickets/:id', ctx => sessions.run(ctx, async state => tickets.status(ctx.params.id, state)));
  router.add('POST', '/admin-api/scan-login/tickets/:id/cancel', ctx => sessions.run(ctx, async state => tickets.cancel(ctx.params.id, state)));
  router.add('POST', '/admin-api/scan-login/tickets/:id/consume', ctx => sessions.run(ctx, async state => ({ user: await tickets.consume(ctx.params.id, state), csrfToken: state.csrf })));
  router.add('POST', '/v2/web-login/tickets/:id/approve', async ctx => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    if (typeof ctx.body.secret !== 'string' || !/^[a-f0-9]{64}$/.test(ctx.body.secret)) throw new ApiError(422, '扫码登录凭据格式无效');
    return { success: true, message: '已确认管理后台登录', data: await tickets.approve(ctx) };
  });
}
