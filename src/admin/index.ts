import type { Context, Handler, Services } from '../core/contracts';
import type { ApiRouter } from '../core/router';
import { ApiError } from '../core/errors';
import { AdminDevices } from './devices';
import { ScanTickets } from './tickets';
import { AdminAuth } from './auth';
import { AdminTokens } from './tokens';
import { AdminTokenStore } from './token-store';

export function registerAdmin(router: ApiRouter, s: Services): void {
  const tokens = new AdminTokens(new AdminTokenStore(s.adminAuthRedis ?? s.redis));
  const auth = new AdminAuth(s.db, tokens), tickets = new ScanTickets(s, auth), devices = new AdminDevices(s);
  const route = (method: string, path: string, operation: Handler) => router.add(method, path, ctx => { ctx.res.setHeader('Cache-Control', 'no-store'); return operation(ctx); });
  const requireUser = async (ctx: Context) => { if (!await auth.user(ctx)) throw new ApiError(401, '请先登录管理后台'); };
  route('GET', '/admin-api/session', async ctx => ({ user: await auth.user(ctx), scanLoginEnabled: tickets.enabled(), authMode: 'jwt' }));
  route('POST', '/admin-api/login', ctx => auth.login(ctx, () => tickets.cancelCurrent(ctx)));
  route('POST', '/admin-api/refresh', ctx => auth.refresh(ctx.body.refreshToken));
  route('POST', '/admin-api/logout', ctx => auth.logout(ctx, () => tickets.cancelCurrent(ctx)));
  route('GET', '/admin-api/devices', async ctx => { await requireUser(ctx); return devices.list(await auth.scope(ctx)); });
  route('DELETE', '/admin-api/devices/:id', async ctx => { await requireUser(ctx); return devices.deleteDevice(Number(ctx.params.id), await auth.scope(ctx)); });
  route('GET', '/admin-api/games', async ctx => { await requireUser(ctx); return s.catalog.getGames(); });
  route('PUT', '/admin-api/devices/:id/game', async ctx => { await requireUser(ctx); return devices.update(Number(ctx.params.id), { gameId: ctx.body.gameId }, await auth.scope(ctx)); });
  route('PUT', '/admin-api/devices/:id/configuration', async ctx => { await requireUser(ctx); return devices.update(Number(ctx.params.id), ctx.body, await auth.scope(ctx)); });
  route('POST', '/admin-api/scan-login/tickets', ctx => tickets.create(ctx));
  route('GET', '/admin-api/scan-login/tickets/:id', ctx => tickets.status(ctx));
  route('POST', '/admin-api/scan-login/tickets/:id/cancel', ctx => tickets.cancel(ctx));
  route('POST', '/admin-api/scan-login/tickets/:id/consume', ctx => tickets.consume(ctx));
  route('POST', '/v2/web-login/tickets/:id/approve', async ctx => {
    if (typeof ctx.body.secret !== 'string' || !/^[a-f0-9]{64}$/.test(ctx.body.secret)) throw new ApiError(422, '扫码登录凭据格式无效');
    return { success: true, message: '已确认管理后台登录', data: await tickets.approve(ctx) };
  });
}
