import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CashSettlementStatus, WalletTransactionType } from '../../shared/enums';
import { PartCustody } from '../part-requests/entities/part-custody.entity';
import { lockCustodyTechnician, p1CustodyEnabled } from '../part-requests/part-custody.policy';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { CustodyPayout } from './entities/custody-payout.entity';
import { WalletTransaction } from './entities/wallet-transaction.entity';
import { WalletService } from './wallet.service';

/** Caller holds the Order lock, serializing callbacks, receipts and sweeps for this invoice. */
export async function settleCustodyOnline(manager: EntityManager, order: ServiceOrder, invoice: Invoice, walletService: WalletService): Promise<{ settled: boolean; reason?: string } | null> {
  if (!p1CustodyEnabled()) return null;
  const custody = await manager.find(PartCustody, { where: { serviceOrderId: order.id } });
  if (!custody.length) return null; // LEGACY is never enrolled by a payment/callback/sweep.
  const cash = await manager.findOne(CashSettlement, { where: { serviceOrderId: order.id } });
  if (cash?.status === CashSettlementStatus.CONFIRMED) return null; // Existing cash fee rules.
  if (cash) return { settled: false, reason: 'CASH_NOT_CONFIRMED' };
  if (await manager.findOne(WalletTransaction, { where: { referenceType: 'SERVICE_ORDER', referenceId: order.id } })) {
    return { settled: false, reason: 'P1_LEGACY_LEDGER_CONFLICT' };
  }
  const assignment = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: order.id, isActive: true }, order: { assignedAt: 'DESC' } });
  if (!assignment) return { settled: false, reason: 'NO_TECHNICIAN_FOUND' };
  await lockCustodyTechnician(manager, assignment.technicianId);
  const netLabor = Number(invoice.laborTotal) - Number(invoice.commissionAmount);
  const netTotal = Number(invoice.grandTotal) - Number(invoice.commissionAmount) - Number(invoice.fixHomePartsTotal) - Number(invoice.shippingFee);
  const nonlabor = netTotal - netLabor;
  if (![netLabor, netTotal, nonlabor].every(value => Number.isSafeInteger(value) && value >= 0)) {
    return { settled: false, reason: 'INVALID_P1_INVOICE_COMPONENTS' };
  }
  const held = custody.some(row => row.state.outstandingQty > 0);
  const wallet = await walletService.getOrCreateWallet(assignment.technicianId, manager);
  let credited = false;
  for (const [component, amount] of [['NONLABOR', nonlabor], ['NET_LABOR', netLabor]] as const) {
    if (component === 'NET_LABOR' && held) continue;
    const existing = await manager.findOne(CustodyPayout, { where: { invoiceId: invoice.id, component } });
    if (existing) {
      if (Number(existing.amount) !== amount || existing.technicianId !== assignment.technicianId) throw new ConflictException('Bút toán quyết toán không khớp hóa đơn.');
      continue;
    }
    const key = `P1:${component}:INVOICE_${invoice.id}`;
    if (amount > 0) await walletService.mutateBalance({
      walletId: wallet.id, type: WalletTransactionType.ONLINE_EARNING, amount,
      referenceType: 'P1_SERVICE_ORDER', referenceId: order.id, idempotencyKey: key,
      description: component === 'NET_LABOR' ? `Tiền công ròng đơn #${order.code}` : `Thu nhập linh kiện đơn #${order.code}`,
      allowNegative: false, manager,
    });
    await manager.insert(CustodyPayout, { invoiceId: invoice.id, serviceOrderId: order.id,
      technicianId: assignment.technicianId, component, amount, idempotencyKey: key });
    credited = true;
  }
  return held ? { settled: false, reason: 'PART_RETURN_OUTSTANDING' }
    : { settled: true, ...(credited ? {} : { reason: 'ALREADY_SETTLED' }) };
}
