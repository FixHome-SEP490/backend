import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { PartCustody, PartCustodyActivation } from './entities/part-custody.entity';

/** Exact opt-in; absent, malformed and false values never touch new storage. */
export function p1CustodyEnabled(): boolean { return process.env.P1_CUSTODY_ENABLED === 'true'; }

/** Refuse a restart into legacy settlement after cutover; never silently drop an existing labor hold. */
export async function assertCustodyRuntimeConfiguration(manager: EntityManager): Promise<void> {
  const [schema] = await manager.query("SELECT to_regclass('part_custodies') IS NOT NULL AS installed");
  if (schema?.installed === false && !p1CustodyEnabled()) return;
  if (schema?.installed !== true) throw new Error('P1_CUSTODY_ENABLED requires the reviewed custody migration');
  if (p1CustodyEnabled()) return;
  const [state] = await manager.query('SELECT EXISTS (SELECT 1 FROM part_custodies) AS enrolled');
  if (state?.enrolled !== false) throw new Error('P1_CUSTODY_ENABLED cannot be disabled after custody cutover; legacy payout is unsafe');
}

export async function custodyActivation(manager: EntityManager): Promise<PartCustodyActivation | null> {
  if (!p1CustodyEnabled()) return null;
  const activation = await manager.findOne(PartCustodyActivation, { where: { id: 1 } });
  if (!activation?.enabled || !(activation.activatedAt instanceof Date) ||
      !Number.isFinite(activation.activatedAt.getTime()) || activation.activatedAt.getTime() > Date.now()) return null;
  return activation;
}

/** Call after any Booking/Order locks, before custody/wallet writes. Never acquire an Order after this. */
export async function lockCustodyTechnician(manager: EntityManager, technicianId: string): Promise<void> {
  if (!p1CustodyEnabled()) return;
  const user = await manager.findOne(User, { where: { id: technicianId }, lock: { mode: 'pessimistic_write' } });
  if (!user) throw new NotFoundException('Không tìm thấy kỹ thuật viên.');
}

/** Advisory at discovery; authoritative when caller holds the technician lock until its write commits. */
export async function hasCashCustodyRestriction(manager: EntityManager, technicianId: string): Promise<boolean> {
  if (!p1CustodyEnabled()) return false;
  const rows: Array<{ blocked: boolean }> = await manager.query(
    `SELECT EXISTS (
       SELECT 1 FROM part_custodies c
       JOIN cash_settlements cs ON cs.service_order_id = c.service_order_id
         AND cs.declared_by_technician_id = c.technician_id
       WHERE c.technician_id = $1 AND (c.state->>'outstandingQty')::int > 0
         AND cs.declared_at IS NOT NULL
     ) AS blocked`, [technicianId]);
  if (typeof rows[0]?.blocked !== 'boolean') throw new ServiceUnavailableException('Chưa xác định được nghĩa vụ trả linh kiện.');
  return rows[0].blocked;
}

export async function assertCashCustodyAllowsWithdrawal(manager: EntityManager, technicianId: string): Promise<void> {
  await lockCustodyTechnician(manager, technicianId);
  if (await hasCashCustodyRestriction(manager, technicianId)) {
    throw new ConflictException('Bạn cần trả đủ linh kiện FixHome và được quản lý xác nhận đã nhận trước khi rút tiền.');
  }
}

/** Only called for a NEW invoice, under the existing Order lock. Never modifies old invoices. */
export async function custodyUsageForInvoice(manager: EntityManager, orderId: string): Promise<Map<string, number>> {
  if (!p1CustodyEnabled()) return new Map();
  const rows = await manager.find(PartCustody, { where: { serviceOrderId: orderId } });
  return new Map(rows.map(row => [row.partRequestItemId, row.state.usedQty]));
}
