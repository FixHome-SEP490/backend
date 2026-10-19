import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { PartCustody, PartCustodyActivation } from './entities/part-custody.entity';

/** Exact opt-in; absent, malformed and false values never touch new storage. */
export function p1CustodyEnabled(): boolean { return process.env.P1_CUSTODY_ENABLED === 'true'; }

/** Physical returns only. Never opts into P1 settlement, billing or withdrawal rules. */
export function partReturnsTrackingEnabled(): boolean { return process.env.PART_RETURNS_TRACKING_ENABLED === 'true'; }
export function custodyTrackingEnabled(): boolean { return p1CustodyEnabled() || partReturnsTrackingEnabled(); }

/** Refuse a restart into legacy settlement after cutover; never silently drop an existing labor hold. */
export async function assertCustodyRuntimeConfiguration(manager: EntityManager): Promise<void> {
  if (p1CustodyEnabled() && partReturnsTrackingEnabled()) throw new Error('P1_CUSTODY_ENABLED cannot be combined with PART_RETURNS_TRACKING_ENABLED');
  const [schema] = await manager.query(`SELECT to_regclass('part_custodies') IS NOT NULL AS installed,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'part_custodies' AND column_name = 'tracking_only') AS tracking_installed`);
  if (schema?.installed === false && !custodyTrackingEnabled()) return;
  if (schema?.installed !== true) throw new Error('P1_CUSTODY_ENABLED requires the reviewed custody migration');
  if (schema.tracking_installed !== true) {
    if (custodyTrackingEnabled()) throw new Error('Custody tracking requires the reviewed return tracking migration');
    const [state] = await manager.query('SELECT EXISTS (SELECT 1 FROM part_custodies) AS enrolled');
    if (state?.enrolled !== false) throw new Error('P1_CUSTODY_ENABLED cannot be disabled after custody cutover; legacy payout is unsafe');
    return;
  }
  const [state] = await manager.query(`SELECT
    EXISTS (SELECT 1 FROM part_custodies WHERE NOT tracking_only) AS p1_enrolled,
    EXISTS (SELECT 1 FROM part_custodies WHERE tracking_only) AS tracking_enrolled`);
  if (typeof state?.p1_enrolled !== 'boolean' || typeof state?.tracking_enrolled !== 'boolean') throw new Error('Unknown custody runtime state');
  if ((state.p1_enrolled && !p1CustodyEnabled()) || (state.tracking_enrolled && !partReturnsTrackingEnabled())) {
    throw new Error('Custody mode cannot change after enrollment; preserve the original finance and return tracking gates');
  }
}

export async function custodyActivation(manager: EntityManager): Promise<PartCustodyActivation | null> {
  if (!custodyTrackingEnabled()) return null;
  const activation = await manager.findOne(PartCustodyActivation, { where: { id: 1 } });
  if (!activation?.enabled || !(activation.activatedAt instanceof Date) ||
      !Number.isFinite(activation.activatedAt.getTime()) || activation.activatedAt.getTime() > Date.now()) return null;
  return activation;
}

/** Call after any Booking/Order locks, before custody/wallet writes. Never acquire an Order after this. */
export async function lockCustodyTechnician(manager: EntityManager, technicianId: string): Promise<void> {
  if (!custodyTrackingEnabled()) return;
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
  if (!p1CustodyEnabled()) return;
  await lockCustodyTechnician(manager, technicianId);
  if (await hasCashCustodyRestriction(manager, technicianId)) {
    throw new ConflictException('Bạn cần trả đủ linh kiện FixHome và được quản lý xác nhận đã nhận trước khi rút tiền.');
  }
}

/** All payment methods; no invoice, payment or cash declaration is required. */
export async function hasPartReturnRestriction(manager: EntityManager, technicianId: string): Promise<boolean> {
  if (!partReturnsTrackingEnabled()) return hasCashCustodyRestriction(manager, technicianId);
  const rows: Array<{ blocked: boolean }> = await manager.query(`SELECT EXISTS (
    SELECT 1 FROM part_custodies c WHERE c.technician_id = $1
      AND c.tracking_only AND (c.state->>'outstandingQty')::int IS DISTINCT FROM 0
  ) AS blocked`, [technicianId]);
  if (typeof rows[0]?.blocked !== 'boolean') throw new ServiceUnavailableException('Chưa xác định được nghĩa vụ trả linh kiện.');
  return rows[0].blocked;
}

/** Only called for a NEW invoice, under the existing Order lock. Never modifies old invoices. */
export async function custodyUsageForInvoice(manager: EntityManager, orderId: string): Promise<Map<string, number>> {
  if (!p1CustodyEnabled()) return new Map();
  const rows = await manager.find(PartCustody, { where: { serviceOrderId: orderId } });
  return new Map(rows.map(row => [row.partRequestItemId, row.state.usedQty]));
}
