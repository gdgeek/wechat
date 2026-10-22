import type { Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';

function integer(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^[\t\n\v\r ]*([+-]?(?:0|[1-9][0-9]*))[\t\n\v\r ]*$/.exec(value);
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(parsed) ? parsed === 0 ? 0 : parsed : null;
}
export function priceInCents(value: unknown): number | null {
  const price = integer(value);
  return price !== null && price >= 0 && price <= 2147483647 ? price : null;
}

/** Ownership and authenticated payment checks shared by mini program routes. */
export class MiniProgramFileService {
  constructor(private readonly db: Pick<Database, 'one' | 'query' | 'execute'>) {}
  ownedQuery(user: Row): { where: string; params: any[] } {
    if (typeof user.unionid === 'string' && user.unionid !== '') return { where: '(user_id = ? OR (user_id IS NULL AND unionid = ?))', params: [Number(user.id), user.unionid] };
    return { where: 'user_id = ?', params: [Number(user.id)] };
  }
  async findOwned(id: unknown, user: Row): Promise<Row> {
    const parsed = integer(id);
    if (parsed === null || parsed < 1) throw new ApiError(400, '文件编号无效', undefined, 'HttpException');
    const owner = this.ownedQuery(user);
    const file = await this.db.one(`SELECT * FROM file WHERE ${owner.where} AND id = ?`, [...owner.params, parsed]);
    if (!file) throw new ApiError(404, '文件不存在或不属于当前账号', undefined, 'HttpException');
    return file;
  }
  prepareOrder(file: Row, user: Row, requestedAmount: unknown = null, requestedOpenid: unknown = null): { amount: number; openid: string; attach: string } {
    const price = priceInCents(file.price);
    if (price === null) throw new ApiError(422, '该历史文件尚未确认收费金额，请联系管理员', undefined, 'HttpException');
    if (price === 0 || file.unlocked && file.unlocked !== '0') throw new ApiError(409, '该文件无需重复支付，请刷新文件状态', undefined, 'HttpException');
    if (requestedAmount !== null && priceInCents(requestedAmount) !== price) throw new ApiError(400, '文件金额已更新，请刷新后重试', undefined, 'HttpException');
    if (typeof user.openid !== 'string' || user.openid === '' || requestedOpenid !== null && requestedOpenid !== user.openid) throw new ApiError(400, '付款账号与当前登录账号不一致', undefined, 'HttpException');
    return { amount: price, openid: user.openid, attach: JSON.stringify({ v: 1, file_id: Number(file.id), user_id: Number(user.id), amount: price }) };
  }
  /** The primary key arbitrates concurrent attempts; an existing binding is immutable. */
  async reserveOrder(orderNo: string, file: Row, user: Row, requestedAmount: unknown = null, requestedOpenid: unknown = null): Promise<{ amount: number; openid: string; attach: string }> {
    this.validateOrderNumber(orderNo);
    const prepared = this.prepareOrder(file, user, requestedAmount, requestedOpenid);
    await this.findOwned(file.id, user);
    try {
      const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
      await this.db.execute('INSERT INTO file_payment_order (out_trade_no,user_id,file_id,amount,created_at) VALUES (?,?,?,?,?)', [orderNo, Number(user.id), Number(file.id), prepared.amount, createdAt]);
    } catch (error: any) {
      if (error?.code !== 'ER_DUP_ENTRY' && !String(error?.sqlState || '').startsWith('23')) throw error;
      const existing = await this.findPaymentOrder(orderNo);
      if (!existing) throw error;
      if (Number(existing.user_id) !== Number(user.id) || Number(existing.file_id) !== Number(file.id) || Number(existing.amount) !== prepared.amount) throw new ApiError(409, '订单编号已绑定其他文件、账号或金额', undefined, 'HttpException');
    }
    return prepared;
  }
  async assertOrderOwner(orderNo: string, user: Row): Promise<Row> {
    const order = await this.findPaymentOrder(orderNo);
    if (!order || Number(order.user_id) !== Number(user.id)) throw new ApiError(403, '订单不存在或不属于当前账号', undefined, 'HttpException');
    return order;
  }
  /** Callback identity comes from the local reservation, never provider attachment fields. */
  async findOrderUser(orderNo: string): Promise<Row> {
    const order = await this.findPaymentOrder(orderNo);
    const user = order ? await this.db.one('SELECT * FROM user WHERE id = ?', [order.user_id]) : null;
    if (!user) throw new ApiError(403, '订单账号不存在', undefined, 'HttpException');
    return user;
  }
  private async findPaymentOrder(orderNo: string): Promise<Row | null> {
    this.validateOrderNumber(orderNo);
    return this.db.one('SELECT * FROM file_payment_order WHERE out_trade_no = ?', [orderNo]);
  }
  private validateOrderNumber(orderNo: string): void {
    if (typeof orderNo !== 'string' || !/^[A-Za-z0-9_-]{6,32}$/.test(orderNo)) throw new ApiError(400, '订单编号无效', undefined, 'HttpException');
  }
  /** Call only with a transaction read from WeChat's authenticated API. */
  async confirmPayment(order: Row, user: Row, appId: string, merchantId: string): Promise<boolean> {
    if (typeof order.out_trade_no !== 'string') throw new ApiError(400, '订单编号无效', undefined, 'HttpException');
    const binding = await this.assertOrderOwner(order.out_trade_no, user);
    if (!appId || !merchantId || order.appid !== appId || order.mchid !== merchantId) throw new ApiError(403, '订单收款方校验失败', undefined, 'HttpException');
    if (['NOTPAY', 'CLOSED', 'REVOKED', 'USERPAYING', 'PAYERROR', 'REFUND'].includes(order.trade_state)) return false;
    if (order.trade_state !== 'SUCCESS') throw new ApiError(403, '订单支付状态无效', undefined, 'HttpException');
    let attachment: Row | null = null;
    try { attachment = typeof order.attach === 'string' ? JSON.parse(order.attach) : null; } catch { /* Invalid provider attachment is rejected below. */ }
    if (!attachment || Array.isArray(attachment) || attachment.v !== 1 || attachment.user_id !== Number(user.id) || attachment.file_id !== Number(binding.file_id) || attachment.amount !== Number(binding.amount)) throw new ApiError(403, '订单不属于当前文件账号', undefined, 'HttpException');
    const file = await this.findOwned(binding.file_id, user), price = priceInCents(file.price);
    if (order.payer?.openid !== user.openid || price === null || price === 0 || attachment.amount !== price || order.amount?.total !== price || order.amount?.currency !== 'CNY') throw new ApiError(403, '订单金额、收款方或付款账号校验失败', undefined, 'HttpException');
    await this.db.execute('UPDATE file SET unlocked=1 WHERE id=?', [file.id]);
    return true;
  }
}
