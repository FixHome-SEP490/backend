import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  PartRequestType,
  PartUsageStatus,
  PaymentStatus,
  WalletTransactionType,
  WarrantyStatus,
} from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { CustomerWalletService } from '../customer-wallet/customer-wallet.service';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { PartRequestItem } from '../part-requests/entities/part-request-item.entity';
import { ReputationService } from '../reputation/reputation.service';
import { assertNoFundedVoucherRefund } from '../vouchers/voucher-refund-guard';
import { WalletTransaction } from '../wallet/entities';
import { WalletService } from '../wallet/wallet.service';
import { Invoice } from './entities/invoice.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';

const REFERENCE = 'WARRANTY_CLAIM';
const invalid = (message: string) => new BusinessException(ErrorCodes.VALIDATION_FAILED, message);

/**
 * The money and reputation side of a warranty claim (PO 04/11/2026). Every method runs in the
 * caller's transaction and is idempotent by key, so a retry never charges or refunds twice.
 */
@Injectable()
export class WarrantyCostService {
  constructor(
    private readonly walletService: WalletService,
    private readonly customerWallet: CustomerWalletService,
    private readonly reputation: ReputationService,
  ) {}

  private partsValue(items: PartRequestItem[]): number {
    return items.reduce((sum, item) => sum + Number(item.unitPriceSnapshot) * item.quantity, 0);
  }

  /** The technician picks up a part their own workmanship made necessary: take its selling price. */
  async chargeOnReceive(manager: EntityManager, request: PartRequest): Promise<void> {
    if (request.requestType !== PartRequestType.WARRANTY || !request.chargeTechnician) return;
    const items = request.items ?? await manager.find(PartRequestItem, { where: { partRequestId: request.id } });
    const amount = this.partsValue(items);
    if (amount <= 0) return;
    const wallet = await this.walletService.getOrCreateWallet(request.technicianId, manager);
    await this.walletService.mutateBalance({
      walletId: wallet.id, type: WalletTransactionType.ADJUSTMENT, debit: true, amount,
      referenceType: REFERENCE, referenceId: request.warrantyClaimId ?? null,
      idempotencyKey: `WARRANTY_PART:${request.id}`,
      description: 'Linh kiện FixHome cấp lại cho bảo hành do lỗi công', allowNegative: true, manager,
    });
  }

  /** A part handed over but returned unused is not charged: give back its share, once. */
  async creditReturned(manager: EntityManager, request: PartRequest, item: PartRequestItem): Promise<void> {
    if (request.requestType !== PartRequestType.WARRANTY || !request.chargeTechnician || item.usageStatus !== PartUsageStatus.RETURNED) return;
    const charged = await manager.findOne(WalletTransaction, { where: { idempotencyKey: `WARRANTY_PART:${request.id}` } });
    if (!charged) return;
    const amount = Number(item.unitPriceSnapshot) * item.quantity;
    if (amount <= 0) return;
    const wallet = await this.walletService.getOrCreateWallet(request.technicianId, manager);
    await this.walletService.mutateBalance({
      walletId: wallet.id, type: WalletTransactionType.ADJUSTMENT, amount,
      referenceType: REFERENCE, referenceId: request.warrantyClaimId ?? null,
      idempotencyKey: `WARRANTY_PART_RETURN:${item.id}`,
      description: 'Hoàn tiền linh kiện bảo hành đã trả lại kho', manager,
    });
  }

  /**
   * The item could not be fixed in time: refund the customer wallet, charge the original
   * technician the same amount (the wallet may go negative; the minimum balance still gates new
   * jobs) and void the coverage when the whole invoice has been refunded. Returns the refund.
   */
  async settleUnfixed(manager: EntityManager, claim: WarrantyClaim, requestedAmount?: number): Promise<number> {
    const order = await manager.findOneBy(ServiceOrder, { id: claim.serviceOrderId });
    const invoice = await manager.findOne(Invoice, { where: { serviceOrderId: claim.serviceOrderId }, lock: { mode: 'pessimistic_write' } });
    if (!order || !invoice || invoice.paymentStatus !== PaymentStatus.PAID) throw invalid('Đơn chưa thanh toán nên không có tiền để hoàn.');
    await assertNoFundedVoucherRefund(manager, invoice.id);

    const coverage = await manager.findOneBy(WarrantyCoverage, { id: claim.warrantyCoverageId });
    const line = coverage?.invoiceItemId ? await manager.findOneBy(InvoiceItem, { id: coverage.invoiceItemId }) : null;
    const amount = requestedAmount ?? Number(line?.lineTotal ?? 0);
    const total = Number(invoice.grandTotal);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid('Nhập số tiền hoàn lớn hơn 0.');
    const already = await this.customerWallet.refundedForOrder(manager, order.id);
    if (already + amount > total) {
      throw invalid(`Tổng tiền hoàn vượt số khách đã trả (${total.toLocaleString('vi-VN')} ₫, đã hoàn ${already.toLocaleString('vi-VN')} ₫).`);
    }
    const booking = await manager.findOneBy(Booking, { id: order.bookingId });
    if (!booking) throw invalid('Không tìm thấy khách của đơn.');

    await this.customerWallet.apply(manager, {
      userId: booking.customerId, type: 'refund', amount,
      idempotencyKey: `REFUND:WARRANTY_${claim.id}`, referenceType: 'SERVICE_ORDER', referenceId: order.id,
      description: `Hoàn tiền bảo hành không khắc phục được đơn #${order.code}`,
    });

    const original = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: order.id }, order: { assignedAt: 'DESC' } });
    const chargedTechnicianId = original?.technicianId ?? claim.technicianId;
    if (chargedTechnicianId) {
      const wallet = await this.walletService.getOrCreateWallet(chargedTechnicianId, manager);
      await this.walletService.mutateBalance({
        walletId: wallet.id, type: WalletTransactionType.ADJUSTMENT, debit: true, amount,
        referenceType: REFERENCE, referenceId: claim.id, idempotencyKey: `WARRANTY_CHARGE:${claim.id}:UNFIXED`,
        description: `Hoàn tiền khách do bảo hành không khắc phục được đơn #${order.code}`, allowNegative: true, manager,
      });
    }
    if (already + amount >= total) {
      await manager.update(WarrantyCoverage, { serviceOrderId: order.id }, { status: WarrantyStatus.VOIDED });
    }
    return amount;
  }

  /** A manager confirmed the technician did not meet the warranty duty. One event per claim and cause. */
  async penalize(
    manager: EntityManager,
    claim: Pick<WarrantyClaim, 'id' | 'technicianId' | 'serviceOrderId' | 'declinedByTechnicianId'>,
    cause: 'decline' | 'no_show' | 'unfixed',
    actorId: string,
    reason: string,
  ): Promise<void> {
    // A decline or a no-show is judged against the technician recorded then; the claim may have moved on.
    const technicianId = cause === 'unfixed' ? claim.technicianId : claim.declinedByTechnicianId;
    if (!technicianId) return;
    await this.reputation.penalizeWarranty(manager, {
      claimId: claim.id, cause, technicianId, serviceOrderId: claim.serviceOrderId, actorId, reason,
    });
  }
}
