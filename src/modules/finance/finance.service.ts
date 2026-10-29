import { CustomerWalletService } from '../customer-wallet/customer-wallet.service';
import { lockCustodyTechnician } from '../part-requests/part-custody.policy';
import { User } from '../users/entities/user.entity';
import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { firstValueFrom, timeout } from 'rxjs';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import {
  CashSettlementStatus,
  CommissionDueStatus,
  PaymentAttemptStatus,
  PaymentMode,
  PaymentPurpose,
  PaymentStatus,
  PlatformDueStatus,
  Role,
  ServiceOrderStatus,
  SupportCaseType,
} from '../../shared/enums';
import { BusinessConfigService } from '../system-config/business-config.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Booking } from '../bookings/entities/booking.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { ServiceOrderStateMachine } from '../service-orders/service-order-state-machine';
import { OrderStatusHistory } from '../service-orders/entities/order-status-history.entity';
import { isCompletionHeld } from '../support-cases/completion-hold';
import { hasOnsiteInterruption } from '../service-orders/onsite-interruption';
import { applyOrderCompletionEffects } from '../service-orders/order-completion-effects';
import { Payment } from './entities/payment.entity';
import { CashPaymentIntent, type CashIntentScope } from './entities/cash-payment-intent.entity';
import { assertCashReceiptMatchesIntent, type CashIntentAllocation } from './cash-intent-policy';
import { PlatformDue } from './entities/platform-due.entity';
import {
  CashSettlementConfirmationDto,
  CashSettlementDeclarationDto,
  CommissionDueResponseDto,
  InitiatePaymentDto,
  InvoiceResponseDto,
  PaymentResponseDto,
  PlatformDueQueryDto,
  PlatformDueResponseDto,
  VoucherCashReservationResponseDto,
  toCashSettlementResponse,
  toCommissionDueResponse,
  toInvoiceResponse,
  toPaymentResponse,
  toPlatformDueResponse,
} from './dto';
import { PaymentVerificationPort, PAYMENT_VERIFICATION_PORT } from './payment-verification.port';
import { SupportCasesService } from '../support-cases/support-cases.service';
import { buildPaymentUrl, buildQueryDrRequest, verifySignature, withWebOrigin } from './vnpay/vnpay.util';
import { loadVisitCharge, sameAllocations, type VisitCharge } from './visit-charge';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { SettlementService } from '../wallet/settlement.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { InvoiceItem } from '../service-orders/entities/invoice-item.entity';
import { RepairEvidence } from '../service-orders/entities/repair-evidence.entity';
import { assertApprovedPartsResolved, assertPartsResolved, closeOrderPartRequests, holderPartRequests, usedPartQuantities } from '../part-requests/part-request-lifecycle';
import { custodyUsageForInvoice } from '../part-requests/part-custody.policy';
import { AdditionalCostStatus, CostItemType, EvidenceType, PartSource, QuotationStatus, ServicePricingMode } from '../../shared/enums';
import { NoChargeInvoiceResponseDto } from './dto';
import { bindVoucherPaymentLink } from '../vouchers/voucher-payment-link';
import { VoucherPaymentLink, type VoucherFundingRail, type VoucherFundingScopeKind } from '../vouchers/entities/voucher-funding.entity';
import { ReservationState } from '../vouchers/voucher.types';
import { VoucherReservation } from '../vouchers/entities/voucher.entity';
import { loadVoucherPreviewInvoices } from '../vouchers/voucher-checkout-preview';
import { allocateVoucherFunding, type VoucherFundingAllocation } from '../vouchers/voucher-funding-allocation';
import { lockVoucherFundingReservation } from '../vouchers/voucher-funding-lock';
import { commitVerifiedVoucherFunding } from '../vouchers/voucher-settlement-evidence';
import { VouchersService } from '../vouchers/vouchers.service';
import { allocateFundedVisitCharge } from './visit-charge';
import { recordSignedVoucherVnpayOutcome } from '../vouchers/voucher-provider-ledger';
import { commitConfirmedCashVoucherFunding } from '../vouchers/voucher-cash-credit';
import { assertVoucherFundingSchemaReady } from '../vouchers/voucher-funding-readiness';

export interface FinanceActor {
  id: string;
  role: string;
}

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

  private cashFirstEnabled(): boolean {
    return this.config?.get<string>('CASH_FIRST_ENABLED') === 'true';
  }

  isCashFirstEnabled(): boolean {
    return this.cashFirstEnabled();
  }

  private legacyCashCompatibilityEnabled(): boolean {
    return this.config?.get<string>('CASH_LEGACY_COMPAT_ENABLED') === 'true';
  }

  /** Called only after the same invoice/VisitGroup locks used by new intent creation. */
  private async assertLegacyCashCompatibility(manager: EntityManager, scopeKind: CashIntentScope, scopeId: string): Promise<void> {
    if (!this.cashFirstEnabled()) return;
    if (!this.legacyCashCompatibilityEnabled()) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Vui lòng chờ khách chọn tiền mặt trước khi xác nhận đã nhận.');
    }
    await this.assertNoActiveCashIntent(manager, scopeKind, scopeId);
  }

  async assertFundedCollectionReady(): Promise<void> {
    if (!this.vouchersService || !this.walletService ||
        !this.customerWalletService || !this.settlementService) {
      throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Thanh toán ưu đãi chưa sẵn sàng, vui lòng thử lại sau.');
    }
    await assertVoucherFundingSchemaReady(this.dataSource);
  }

  /** Legacy payment routes also run before the additive F4 schema exists.
   * Missing ONLY the new funding table means there cannot be a funded link.
   * Do not hide any other database failure or weaken funded route readiness. */
  private async findOptionalVoucherPaymentLink(where: { paymentId?: string; cashSettlementId?: string; visitGroupPaymentId?: string }): Promise<VoucherPaymentLink | null> {
    try {
      return await this.dataSource.getRepository(VoucherPaymentLink).findOne({ where });
    } catch (error) {
      const db = error as { driverError?: { code?: string; message?: string }; code?: string; message?: string };
      const code = db.driverError?.code ?? db.code;
      const message = db.driverError?.message ?? db.message ?? '';
      if (code === '42P01' && /relation ["']?[^"'\s]*voucher_payment_links["']? does not exist/i.test(message)) return null;
      throw error;
    }
  }
  /** Caller holds the scope's invoice locks, shared with Apply/checkout. */
  private async assertLegacyCollectionAllowed(manager: EntityManager, scopeId: string): Promise<void> {
    const held = await manager.findOne(VoucherReservation, {
      where: { scopeId, state: ReservationState.RESERVED },
    });
    if (held) {
      throw new BusinessException(ErrorCodes.CONFLICT,
        'Đơn đang áp dụng ưu đãi. Vui lòng tiếp tục thanh toán ưu đãi hoặc hủy áp dụng trước.');
    }
  }

  /** New initiation only; existing cash/provider confirmation keeps its original guards. */
  private async assertNewCollectionAllowed(manager: EntityManager, scopeId: string, scopeKind: CashIntentScope = 'SOLO'): Promise<void> {
    await this.assertNoStoppedCollection(manager, scopeId, scopeKind);
    await this.assertLegacyCollectionAllowed(manager, scopeId);
  }

  private async assertNoStoppedCollection(manager: EntityManager, scopeId: string, scopeKind: CashIntentScope = 'SOLO'): Promise<void> {
    // Group callers already hold the group lock. Reuse T8's locked invoice/child
    // exposure proof: an unbilled stopped child must not block successful siblings.
    const held = scopeKind === 'VISIT_GROUP'
      ? (await loadVisitCharge(manager, scopeId, true)).financialFollowupRequired
      : await hasOnsiteInterruption(manager, scopeId);
    if (held) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Công việc đã gián đoạn. Không tạo khoản thu mới; nghĩa vụ cũ cần FixHome đối soát.');
    }
  }

  private async assertNoActiveCashIntent(manager: EntityManager, scopeKind: CashIntentScope, scopeId: string): Promise<void> {
    if (!this.cashFirstEnabled()) return;
    if (await manager.findOne(CashPaymentIntent, { where: { scopeKind, scopeId, status: 'pending' } })) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Khách đã chọn tiền mặt. Vui lòng hủy lựa chọn đó trước khi đổi phương thức.');
    }
  }

  /** A customer selection is durable, but it never proves that physical cash changed hands. */
  async createCashIntent(scopeKind: CashIntentScope, scopeId: string,
    input: { commandId: string; voucherReservationId?: string }, actor: FinanceActor): Promise<CashPaymentIntent> {
    if (!this.cashFirstEnabled()) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Thanh toán tiền mặt theo bước mới chưa được mở.');
    }
    if (actor.role !== Role.CUSTOMER) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Chỉ khách hàng được chọn thanh toán tiền mặt.');
    }
    if (input.voucherReservationId) await this.assertFundedCollectionReady();
    const replay = await this.dataSource.getRepository(CashPaymentIntent).findOne({
      where: { customerId: actor.id, commandId: input.commandId },
    });
    if (replay) {
      if (replay.scopeKind === scopeKind && replay.scopeId === scopeId &&
          replay.voucherReservationId === (input.voucherReservationId ?? null)) return replay;
      throw new BusinessException(ErrorCodes.CONFLICT, 'Mã thao tác đã được dùng.');
    }
    return this.dataSource.transaction(async manager => {
      let customerId: string;
      let technicianId: string;
      let gross: number;
      let due: number;
      let allocations: CashIntentAllocation[];
      if (scopeKind === 'SOLO') {
        const reference = await manager.findOneBy(Invoice, { serviceOrderId: scopeId });
        if (!reference) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Không tìm thấy hóa đơn.');
        const quote = input.voucherReservationId ? await this.quoteVoucherRail(manager, {
          reservationId: input.voucherReservationId, customerId: actor.id, scopeId,
          scopeKind, rail: 'CASH', invoiceId: reference.id,
        }) : null;
        const invoice = await manager.findOne(Invoice, { where: { id: reference.id }, lock: { mode: 'pessimistic_write' } });
        const order = await manager.findOne(ServiceOrder, { where: { id: scopeId }, lock: { mode: 'pessimistic_write' } });
        const booking = order && await manager.findOne(Booking, { where: { id: order.bookingId } });
        if (!invoice || !order || !booking || booking.customerId !== actor.id || booking.visitGroupId ||
            invoice.serviceOrderId !== scopeId) {
          throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Không tìm thấy đơn sửa chữa.');
        }
        await this.assertNoStoppedCollection(manager, scopeId, scopeKind);
        const assignment = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: scopeId, isActive: true } });
        if (!assignment || !order.completionRequestedAt ||
            ![ServiceOrderStatus.UNDER_REPAIR, ServiceOrderStatus.COMPLETED].includes(order.status) ||
            invoice.paymentStatus === PaymentStatus.PAID || await isCompletionHeld(manager, scopeId)) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Đơn chưa sẵn sàng thanh toán tiền mặt.');
        }
        customerId = booking.customerId;
        technicianId = assignment.technicianId;
        gross = this.requireWholeVnd(invoice.grandTotal, 'Invoice amount');
        due = quote?.total.customerDueVnd ?? gross;
        if (quote && quote.total.originalGrossVnd !== gross) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Hóa đơn đã thay đổi.');
        }
        allocations = [{ invoiceId: invoice.id, serviceOrderId: scopeId, originalGrossVnd: gross, customerDueVnd: due }];
        if (await manager.findOne(CashSettlement, { where: { serviceOrderId: scopeId } })) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Đơn đã có khai báo tiền mặt cần được xử lý trước.');
        }
      } else {
        const reference = await manager.findOneBy(VisitGroup, { id: scopeId });
        if (!reference || reference.customerId !== actor.id) {
          throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Không tìm thấy lượt sửa.');
        }
        const quote = input.voucherReservationId ? await this.quoteVoucherRail(manager, {
          reservationId: input.voucherReservationId, customerId: actor.id, scopeId,
          scopeKind, rail: 'CASH',
        }) : null;
        await this.visitAccess(manager, scopeId, actor, true);
        await this.assertNoStoppedCollection(manager, scopeId, scopeKind);
        const charge = await this.readyVisitCharge(manager, scopeId);
        const funded = quote ? allocateFundedVisitCharge(charge, quote) : null;
        gross = charge.total;
        due = funded?.customerDue ?? gross;
        allocations = charge.allocations.map(item => ({
          invoiceId: item.invoiceId, serviceOrderId: item.serviceOrderId,
          originalGrossVnd: item.amount,
          customerDueVnd: funded?.allocations.find(a => a.invoiceId === item.invoiceId)?.amount ?? item.amount,
        }));
        customerId = reference.customerId;
        const assignments: string[] = [];
        for (const item of allocations) {
          const order = await manager.findOne(ServiceOrder, { where: { id: item.serviceOrderId } });
          const booking = order && await manager.findOne(Booking, { where: { id: order.bookingId } });
          const assignment = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: item.serviceOrderId, isActive: true } });
          if (!order || !booking || booking.visitGroupId !== scopeId || booking.customerId !== actor.id ||
              !order.completionRequestedAt || !assignment || await isCompletionHeld(manager, item.serviceOrderId) ||
              await manager.findOne(CashSettlement, { where: { serviceOrderId: item.serviceOrderId } })) {
            throw new BusinessException(ErrorCodes.CONFLICT, 'Lượt sửa chưa sẵn sàng thanh toán tiền mặt.');
          }
          assignments.push(assignment.technicianId);
        }
        if (!assignments.length || assignments.some(id => id !== assignments[0])) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Kỹ thuật viên của lượt sửa không nhất quán.');
        }
        technicianId = assignments[0];
        const previous = await manager.find(VisitGroupPayment, { where: { visitGroupId: scopeId } });
        if (previous.some(row => row.rail === 'cash' || row.status === 'verified' || row.status === 'pending')) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Lượt sửa có thanh toán đang xử lý.');
        }
      }
      if (due <= 0 || gross <= 0 || !Number.isSafeInteger(due) || !Number.isSafeInteger(gross)) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Khoản 0 ₫ dùng bước xác nhận miễn phí.');
      }
      if (!input.voucherReservationId) await this.assertLegacyCollectionAllowed(manager, scopeId);
      const invoiceIds = allocations.map(item => item.invoiceId);
      const attempts = await manager.find(Payment, { where: { invoiceId: In(invoiceIds), purpose: PaymentPurpose.INVOICE } });
      if (attempts.some(row => row.status === PaymentAttemptStatus.PENDING || row.status === PaymentAttemptStatus.VERIFIED)) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Có giao dịch thanh toán đang xử lý. Vui lòng kiểm tra lại.');
      }
      if (input.voucherReservationId && await manager.findOne(VoucherPaymentLink, { where: { reservationId: input.voucherReservationId } })) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Ưu đãi đã có thanh toán đang xử lý.');
      }
      const previous = await manager.findOne(CashPaymentIntent, {
        where: { scopeKind, scopeId, status: 'pending' }, lock: { mode: 'pessimistic_write' },
      });
      if (previous) {
        if (previous.customerId === actor.id && previous.commandId === input.commandId &&
            previous.voucherReservationId === (input.voucherReservationId ?? null)) return previous;
        throw new BusinessException(ErrorCodes.CONFLICT, 'Đã chọn thanh toán tiền mặt cho đơn này.');
      }
      const reused = await manager.findOne(CashPaymentIntent, { where: { customerId: actor.id, commandId: input.commandId } });
      if (reused) throw new BusinessException(ErrorCodes.CONFLICT, 'Mã thao tác đã được dùng.');
      const intent = await manager.save(CashPaymentIntent, manager.create(CashPaymentIntent, {
        scopeKind, scopeId, customerId, technicianId, status: 'pending', grossVnd: gross,
        customerDueVnd: due, allocations, voucherReservationId: input.voucherReservationId ?? null,
        commandId: input.commandId, receiptCommandId: null, cancelCommandId: null, receivedAmountVnd: null,
        receiptEvidenceUrl: null, receivedAt: null, cashSettlementId: null, visitGroupPaymentId: null,
      }));
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role,
        action: 'CASH_INTENT_CREATED', resourceType: 'cash_payment_intent', resourceId: intent.id,
        after: { scopeKind, scopeId, amount: due, voucherReservationId: input.voucherReservationId ?? null } });
      await manager.insert(Notification, { userId: technicianId,
        title: 'Khách đã chọn thanh toán tiền mặt',
        message: `Khách đã chọn trả ${due.toLocaleString('vi-VN')} ₫ bằng tiền mặt. Chỉ xác nhận sau khi đã thực nhận đủ tiền.`,
        type: 'CASH_INTENT_CREATED', referenceType: scopeKind, referenceId: scopeId, isRead: false });
      return intent;
    });
  }

  /** The only new cash-to-PAID path: a current technician acknowledges actual receipt. */
  async receiveCashIntent(scopeKind: CashIntentScope, scopeId: string,
    input: { intentId: string; commandId: string; receivedAmountVnd: number; receiptEvidenceUrl?: string },
    actor: FinanceActor): Promise<CashPaymentIntent> {
    if (!this.cashFirstEnabled()) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Thanh toán tiền mặt theo bước mới chưa được mở.');
    }
    if (actor.role !== Role.TECHNICIAN) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Chỉ kỹ thuật viên phụ trách được xác nhận đã nhận tiền.');
    }
    const sameReplay = (intent: CashPaymentIntent) => intent.status === 'received' &&
      intent.scopeKind === scopeKind && intent.scopeId === scopeId &&
      intent.technicianId === actor.id && intent.receiptCommandId === input.commandId &&
      Number(intent.receivedAmountVnd) === input.receivedAmountVnd &&
      (intent.receiptEvidenceUrl ?? null) === (input.receiptEvidenceUrl ?? null);
    const reference = await this.dataSource.getRepository(CashPaymentIntent).findOneBy({ id: input.intentId });
    if (!reference || reference.scopeKind !== scopeKind || reference.scopeId !== scopeId ||
        reference.technicianId !== actor.id) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Không tìm thấy yêu cầu tiền mặt.');
    }
    if (sameReplay(reference)) return reference;
    if (reference.status !== 'pending') throw new BusinessException(ErrorCodes.CONFLICT, 'Yêu cầu tiền mặt không còn chờ nhận.');
    if (reference.voucherReservationId) await this.assertFundedCollectionReady();
    try {
      return await this.dataSource.transaction(async manager => {
        // Voucher rails take campaign and reservation locks before invoice locks.
        const quote = reference.voucherReservationId ? await this.quoteVoucherRail(manager, {
          reservationId: reference.voucherReservationId, customerId: reference.customerId,
          scopeId, scopeKind, rail: 'CASH',
          invoiceId: scopeKind === 'SOLO' ? reference.allocations[0]?.invoiceId : undefined,
        }) : null;
        let allocations: CashIntentAllocation[];
        let group: VisitGroup | null = null;
        if (scopeKind === 'SOLO') {
          const invoice = await manager.findOne(Invoice, { where: { id: reference.allocations[0]?.invoiceId }, lock: { mode: 'pessimistic_write' } });
          const order = await manager.findOne(ServiceOrder, { where: { id: scopeId }, lock: { mode: 'pessimistic_write' } });
          const booking = order && await manager.findOne(Booking, { where: { id: order.bookingId } });
          const assignment = order && await manager.findOne(TechnicianAssignment, { where: {
            serviceOrderId: scopeId, technicianId: actor.id, isActive: true,
          } });
          if (!invoice || !order || !booking || booking.customerId !== reference.customerId || booking.visitGroupId ||
              invoice.serviceOrderId !== scopeId || !assignment || !order.completionRequestedAt ||
              ![ServiceOrderStatus.UNDER_REPAIR, ServiceOrderStatus.COMPLETED].includes(order.status) ||
              invoice.paymentStatus === PaymentStatus.PAID || await isCompletionHeld(manager, scopeId)) {
            throw new BusinessException(ErrorCodes.CONFLICT, 'Đơn hoặc kỹ thuật viên đã thay đổi.');
          }
          const gross = this.requireWholeVnd(invoice.grandTotal, 'Invoice amount');
          allocations = [{ invoiceId: invoice.id, serviceOrderId: scopeId,
            originalGrossVnd: gross, customerDueVnd: quote?.total.customerDueVnd ?? gross }];
        } else {
          group = await this.visitAccess(manager, scopeId, actor, true);
          if (group.customerId !== reference.customerId) {
            throw new BusinessException(ErrorCodes.CONFLICT, 'Chủ lượt sửa đã thay đổi.');
          }
          const charge = await this.readyVisitCharge(manager, scopeId);
          const funded = quote ? allocateFundedVisitCharge(charge, quote) : null;
          allocations = charge.allocations.map(item => ({ invoiceId: item.invoiceId,
            serviceOrderId: item.serviceOrderId, originalGrossVnd: item.amount,
            customerDueVnd: funded?.allocations.find(a => a.invoiceId === item.invoiceId)?.amount ?? item.amount }));
        }
        const intent = await manager.findOne(CashPaymentIntent, { where: { id: input.intentId }, lock: { mode: 'pessimistic_write' } });
        if (!intent || intent.scopeKind !== scopeKind || intent.scopeId !== scopeId ||
            intent.customerId !== reference.customerId) {
          throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Không tìm thấy yêu cầu tiền mặt.');
        }
        if (sameReplay(intent)) return intent;
        if (intent.status !== 'pending') throw new BusinessException(ErrorCodes.CONFLICT, 'Yêu cầu tiền mặt không còn chờ nhận.');
        assertCashReceiptMatchesIntent(intent, actor.id, input.receivedAmountVnd, allocations);
        if (!intent.voucherReservationId) await this.assertLegacyCollectionAllowed(manager, scopeId);
        const invoiceIds = allocations.map(item => item.invoiceId);
        const attempts = await manager.find(Payment, { where: { invoiceId: In(invoiceIds), purpose: PaymentPurpose.INVOICE } });
        if (attempts.some(row => row.status === PaymentAttemptStatus.PENDING || row.status === PaymentAttemptStatus.VERIFIED)) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Có thanh toán khác chưa ngã ngũ. Vui lòng kiểm tra lại.');
        }
        if (scopeKind === 'SOLO') {
          if (await manager.findOne(CashSettlement, { where: { serviceOrderId: scopeId } })) {
            throw new BusinessException(ErrorCodes.CONFLICT, 'Đã có khai báo tiền mặt khác.');
          }
        } else {
          const otherPayments = await manager.find(VisitGroupPayment, { where: { visitGroupId: scopeId } });
          if (otherPayments.some(row => row.rail === 'cash' || row.status === 'pending' || row.status === 'verified')) {
            throw new BusinessException(ErrorCodes.CONFLICT, 'Lượt sửa có thanh toán khác đang xử lý.');
          }
        }
        const groupOrders = new Map<string, { order: ServiceOrder; invoice: Invoice }>();
        if (scopeKind === 'VISIT_GROUP') {
          // All order locks precede the technician custody/user lock.
          for (const allocation of [...allocations].sort((a, b) => a.serviceOrderId.localeCompare(b.serviceOrderId))) {
            const order = await manager.findOne(ServiceOrder, { where: { id: allocation.serviceOrderId }, lock: { mode: 'pessimistic_write' } });
            const invoice = await manager.findOne(Invoice, { where: { id: allocation.invoiceId } });
            const booking = order && await manager.findOne(Booking, { where: { id: order.bookingId } });
            const assignment = order && await manager.findOne(TechnicianAssignment, { where: {
              serviceOrderId: order.id, technicianId: actor.id, isActive: true,
            } });
            if (!order || !invoice || !booking || booking.customerId !== intent.customerId ||
                booking.visitGroupId !== scopeId || !assignment || !order.completionRequestedAt ||
                await isCompletionHeld(manager, order.id) ||
                await manager.findOne(CashSettlement, { where: { serviceOrderId: order.id } })) {
              throw new BusinessException(ErrorCodes.CONFLICT, 'Một thiết bị hoặc kỹ thuật viên đã thay đổi.');
            }
            groupOrders.set(order.id, { order, invoice });
          }
        }
        await lockCustodyTechnician(manager, actor.id);
        const now = new Date();
        if (scopeKind === 'SOLO') {
          const allocation = allocations[0];
          const order = await manager.findOneOrFail(ServiceOrder, { where: { id: scopeId } });
          const invoice = await manager.findOneOrFail(Invoice, { where: { id: allocation.invoiceId } });
          const settlement = await manager.save(CashSettlement, manager.create(CashSettlement, {
            serviceOrderId: scopeId, declaredByTechnicianId: actor.id,
            declaredAmount: allocation.customerDueVnd, declaredAt: now,
            receiptEvidenceUrl: input.receiptEvidenceUrl ?? null,
            status: CashSettlementStatus.PENDING_CONFIRMATION,
          }));
          if (intent.voucherReservationId) {
            await this.bindVoucherPaymentAfterRecord(manager, { reservationId: intent.voucherReservationId,
              rail: 'CASH', sourceId: settlement.id, customerId: intent.customerId,
              scopeId, scopeKind: 'SOLO' });
          }
          settlement.status = CashSettlementStatus.CONFIRMED;
          // The customer confirmed the intent before this receipt; there is no later approval.
          settlement.confirmedByCustomerId = intent.customerId;
          settlement.confirmedAmount = allocation.customerDueVnd;
          settlement.confirmedAt = now;
          await manager.save(CashSettlement, settlement);
          await this.applyConfirmedCash(manager, { order, invoice, settlement, actor, now,
            collectedAmount: allocation.customerDueVnd });
          intent.cashSettlementId = settlement.id;
        } else {
          const payment = await manager.save(VisitGroupPayment, manager.create(VisitGroupPayment, {
            visitGroupId: scopeId, rail: 'cash', status: 'pending_confirmation',
            amount: intent.customerDueVnd, allocations: allocations.map(item => ({
              invoiceId: item.invoiceId, serviceOrderId: item.serviceOrderId, amount: item.customerDueVnd,
            })), idempotencyKey: `CASH_INTENT:${intent.id}`, requestedByUserId: actor.id,
            requestedAt: now,
          }));
          if (intent.voucherReservationId) {
            await this.bindVoucherPaymentAfterRecord(manager, { reservationId: intent.voucherReservationId,
              rail: 'CASH', sourceId: payment.id, customerId: intent.customerId,
              scopeId, scopeKind: 'VISIT_GROUP' });
          }
          for (const allocation of allocations) {
            const locked = groupOrders.get(allocation.serviceOrderId);
            if (!locked || locked.invoice.id !== allocation.invoiceId) {
              throw new BusinessException(ErrorCodes.CONFLICT, 'Phân bổ lượt sửa đã thay đổi.');
            }
            const { order, invoice } = locked;
            const settlement = await manager.save(CashSettlement, manager.create(CashSettlement, {
              serviceOrderId: order.id, declaredByTechnicianId: actor.id,
              declaredAmount: allocation.customerDueVnd, declaredAt: now,
              status: CashSettlementStatus.CONFIRMED,
              confirmedByCustomerId: intent.customerId,
              confirmedAmount: allocation.customerDueVnd, confirmedAt: now,
              receiptEvidenceUrl: input.receiptEvidenceUrl ?? null,
              technicianNotes: `Thu chung lượt sửa ${scopeId}`,
            }));
            await this.applyConfirmedCash(manager, { order, invoice, settlement, actor, now,
              collectedAmount: allocation.customerDueVnd });
          }
          payment.status = 'verified';
          payment.verifiedAt = now;
          await manager.save(VisitGroupPayment, payment);
          intent.visitGroupPaymentId = payment.id;
        }
        if (intent.voucherReservationId) {
          if (!this.walletService || !this.vouchersService) {
            throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Thanh toán ưu đãi chưa sẵn sàng.');
          }
          await commitConfirmedCashVoucherFunding(manager, intent.voucherReservationId, this.walletService);
          await this.vouchersService.redeemSettled(intent.cashSettlementId ?? intent.visitGroupPaymentId!, manager);
        }
        intent.status = 'received';
        intent.receiptCommandId = input.commandId;
        intent.receivedAmountVnd = input.receivedAmountVnd;
        intent.receiptEvidenceUrl = input.receiptEvidenceUrl ?? null;
        intent.receivedAt = now;
        const saved = await manager.save(CashPaymentIntent, intent);
        await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role,
          action: 'CASH_INTENT_RECEIVED', resourceType: 'cash_payment_intent', resourceId: intent.id,
          after: { scopeKind, scopeId, amount: intent.customerDueVnd } });
        await manager.insert(Notification, { userId: intent.customerId,
          title: 'Đã ghi nhận thanh toán tiền mặt',
          message: 'Kỹ thuật viên đã xác nhận thực nhận tiền mặt. Thanh toán của bạn đã được ghi nhận.',
          type: 'CASH_INTENT_RECEIVED', referenceType: scopeKind, referenceId: scopeId, isRead: false });
        return saved;
      });
    } catch (error) {
      const latest = await this.dataSource.getRepository(CashPaymentIntent).findOneBy({ id: input.intentId });
      if (latest && sameReplay(latest)) return latest;
      throw error;
    }
  }

  async cancelCashIntent(scopeKind: CashIntentScope, scopeId: string,
    input: { intentId: string; commandId: string }, actor: FinanceActor): Promise<CashPaymentIntent> {
    if (actor.role !== Role.CUSTOMER) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Chỉ khách hàng được hủy lựa chọn tiền mặt.');
    }
    return this.dataSource.transaction(async manager => {
      const intent = await manager.findOne(CashPaymentIntent, { where: { id: input.intentId }, lock: { mode: 'pessimistic_write' } });
      if (!intent || intent.scopeKind !== scopeKind || intent.scopeId !== scopeId || intent.customerId !== actor.id) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Không tìm thấy yêu cầu tiền mặt.');
      }
      if (intent.status === 'cancelled' && intent.cancelCommandId === input.commandId) return intent;
      if (intent.status !== 'pending') {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Yêu cầu tiền mặt không thể hủy ở trạng thái hiện tại.');
      }
      intent.status = 'cancelled';
      intent.cancelCommandId = input.commandId;
      const saved = await manager.save(CashPaymentIntent, intent);
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role,
        action: 'CASH_INTENT_CANCELLED', resourceType: 'cash_payment_intent', resourceId: intent.id,
        after: { scopeKind, scopeId } });
      return saved;
    });
  }

  async getCashIntent(scopeKind: CashIntentScope, scopeId: string, actor: FinanceActor): Promise<CashPaymentIntent | null> {
    if (scopeKind === 'SOLO') {
      const order = await this.dataSource.manager.findOneBy(ServiceOrder, { id: scopeId });
      const booking = order && await this.dataSource.manager.findOneBy(Booking, { id: order.bookingId });
      if (!booking || booking.visitGroupId ||
          (actor.role === Role.CUSTOMER && booking.customerId !== actor.id) ||
          (actor.role === Role.TECHNICIAN && !await this.dataSource.manager.findOne(TechnicianAssignment, {
            where: { serviceOrderId: scopeId, technicianId: actor.id, isActive: true },
          })) || ![Role.CUSTOMER, Role.TECHNICIAN, Role.SERVICE_MANAGER, Role.ADMIN].includes(actor.role as Role)) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Không tìm thấy đơn sửa chữa.');
      }
    } else if (actor.role === Role.SERVICE_MANAGER || actor.role === Role.ADMIN) {
      const group = await this.dataSource.manager.findOneBy(VisitGroup, { id: scopeId });
      if (!group) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Không tìm thấy lượt sửa.');
    } else {
      await this.visitAccess(this.dataSource.manager, scopeId, actor);
    }
    return this.dataSource.getRepository(CashPaymentIntent).findOne({
      where: { scopeKind, scopeId, status: In(['pending', 'received']) }, order: { createdAt: 'DESC' },
    });
  }

  /** Read-only discovery, never a declaration or permission to collect without POST validation. */
  async getVoucherCashReservation(scopeKind: VoucherFundingScopeKind, scopeId: string,
    actor: FinanceActor): Promise<VoucherCashReservationResponseDto> {
    if (actor.role !== Role.TECHNICIAN) {
      throw new BusinessException(ErrorCodes.RBAC_FORBIDDEN, 'Chỉ kỹ thuật viên được xem thông tin thu tiền.');
    }
    const denied = (): never => { throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Không tìm thấy công việc.'); };
    const conflict = (): never => { throw new BusinessException(ErrorCodes.CONFLICT, 'Thông tin thu tiền đã thay đổi. Vui lòng kiểm tra lại.'); };
    return this.dataSource.transaction(async manager => {
      let customerId: string;
      let invoiceId: string | undefined;
      if (scopeKind === 'SOLO') {
        const order = await manager.findOneBy(ServiceOrder, { id: scopeId });
        const booking = order && await manager.findOneBy(Booking, { id: order.bookingId });
        const assignment = order && await manager.findOne(TechnicianAssignment, {
          where: { serviceOrderId: order.id, technicianId: actor.id, isActive: true },
        });
        if (!order || !booking || booking.visitGroupId || !assignment) denied();
        customerId = booking.customerId;
        const invoice = await manager.findOneBy(Invoice, { serviceOrderId: scopeId });
        if (!invoice) conflict();
        invoiceId = invoice.id;
      } else {
        customerId = (await this.visitAccess(manager, scopeId, actor)).customerId;
      }
      await this.assertFundedCollectionReady();
      // Do not filter by customer: a mismatched live owner is a conflict, never NONE.
      const reservations = await manager.find(VoucherReservation, {
        where: { scopeId, state: In([ReservationState.RESERVED, ReservationState.REDEEMED]) }, take: 2,
      });
      if (reservations.length > 1) conflict();
      const reservation = reservations[0];
      if (reservation && (reservation.state !== ReservationState.RESERVED || reservation.customerId !== customerId)) conflict();
      const quote = reservation ? await this.quoteVoucherRail(manager, {
        reservationId: reservation.id, customerId, scopeId, scopeKind, rail: 'CASH', invoiceId,
      }) : null;
      const facts = quote ?? await loadVoucherPreviewInvoices(manager, customerId, scopeId, true);
      const invoiceIds = facts.invoices.map(invoice => invoice.invoiceId);
      const invoices = await manager.find(Invoice, { where: { id: In(invoiceIds) } });
      if (!invoiceIds.length || invoices.length !== invoiceIds.length) conflict();
      // Recheck current assignment and ownership after acquiring frozen invoice locks.
      for (const invoice of invoices) {
        const order = await manager.findOne(ServiceOrder, { where: { id: invoice.serviceOrderId }, lock: { mode: 'pessimistic_read' } });
        const booking = order && await manager.findOne(Booking, { where: { id: order.bookingId }, lock: { mode: 'pessimistic_read' } });
        const assignment = order && await manager.findOne(TechnicianAssignment, {
          where: { serviceOrderId: order.id, technicianId: actor.id, isActive: true }, lock: { mode: 'pessimistic_read' },
        });
        if (!order || !booking || !assignment || booking.customerId !== customerId ||
            (scopeKind === 'SOLO' ? order.id !== scopeId || !!booking.visitGroupId : booking.visitGroupId !== scopeId)) denied();
      }
      // Apply may have committed while this lookup waited for the invoice locks.
      // Retry discovery without reversing the campaign -> invoice lock order.
      if (!reservation && await manager.findOne(VoucherReservation, {
        where: { scopeId, state: In([ReservationState.RESERVED, ReservationState.REDEEMED]) },
      })) conflict();
      if (await manager.exists(VoucherPaymentLink, { where: { scopeId } }) ||
          await manager.exists(Payment, { where: { invoiceId: In(invoiceIds) } }) ||
          await manager.exists(CashSettlement, { where: { serviceOrderId: In(invoices.map(invoice => invoice.serviceOrderId)) } }) ||
          (scopeKind === 'VISIT_GROUP' && await manager.exists(VisitGroupPayment, { where: { visitGroupId: scopeId } }))) conflict();
      return reservation && quote
        ? { voucherReservationId: reservation.id, customerDueVnd: quote.total.customerDueVnd }
        : { voucherReservationId: null, customerDueVnd: null };
    });
  }

  /** Server money quote from a locked reservation and frozen invoices. */
  async quoteVoucherRail(
    manager: EntityManager,
    input: {
      reservationId: string;
      customerId: string;
      scopeId: string;
      scopeKind: VoucherFundingScopeKind;
      rail: VoucherFundingRail;
      invoiceId?: string;
    },
  ): Promise<VoucherFundingAllocation> {
    const unavailable = (): never => {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Ưu đãi chưa sẵn sàng thanh toán.');
    };
    if (!manager.queryRunner?.isTransactionActive ||
        !(['WALLET', 'VNPAY', 'CASH', 'ZERO'] as string[]).includes(input.rail) ||
        !input.reservationId || !input.customerId || !input.scopeId) unavailable();
    const reservation = await lockVoucherFundingReservation(manager, input.reservationId);
    const now = new Date((await manager.query('SELECT clock_timestamp() AS now'))[0]?.now);
    if (!reservation || reservation.state !== ReservationState.RESERVED ||
        reservation.customerId !== input.customerId || reservation.scopeId !== input.scopeId ||
        !Number.isFinite(+now) || +now < +reservation.reservedAt || +now >= +reservation.expiresAt) unavailable();
    const group = await manager.findOneBy(VisitGroup, { id: input.scopeId });
    if ((input.scopeKind === 'VISIT_GROUP') !== !!group ||
        (group && group.customerId !== input.customerId)) unavailable();
    const facts = await loadVoucherPreviewInvoices(manager, input.customerId, input.scopeId, true);
    const quote = allocateVoucherFunding({ policy: reservation.policySnapshot, invoices: facts.invoices });
    if (quote.total.eligibleBaseVnd !== reservation.checkoutSnapshot.eligibleSubtotalVnd ||
        (input.scopeKind === 'SOLO' &&
          (quote.invoices.length !== 1 || quote.invoices[0].invoiceId !== input.invoiceId)) ||
        (input.rail === 'ZERO' ? quote.total.customerDueVnd !== 0 : quote.total.customerDueVnd <= 0) ||
        (input.rail === 'VNPAY' && quote.total.customerDueVnd < 5000)) unavailable();
    return quote;
  }

  /** Bind a created rail record in its transaction before debit completion or provider URL. */
  async bindVoucherPaymentAfterRecord(
    manager: EntityManager,
    input: {
      reservationId: string;
      rail: Exclude<VoucherFundingRail, 'ZERO'>;
      sourceId: string;
      customerId: string;
      scopeId: string;
      scopeKind: VoucherFundingScopeKind;
    },
  ): Promise<VoucherPaymentLink> {
    if (!manager.queryRunner?.isTransactionActive ||
        !(['WALLET', 'VNPAY', 'CASH'] as string[]).includes(input.rail) ||
        !input.reservationId || !input.sourceId || !input.customerId || !input.scopeId) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Không thể liên kết thanh toán ưu đãi.');
    }
    const link = await bindVoucherPaymentLink(manager, input.reservationId, input.rail, input.sourceId);
    const sourceField = input.scopeKind === 'VISIT_GROUP' ? 'visitGroupPaymentId'
      : input.rail === 'CASH' ? 'cashSettlementId' : 'paymentId';
    if (link.reservationId !== input.reservationId ||
        link.customerId !== input.customerId || link.scopeId !== input.scopeId ||
        link.scopeKind !== input.scopeKind || link.rail !== input.rail ||
        link[sourceField] !== input.sourceId) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Không thể liên kết thanh toán ưu đãi.');
    }
    return link;
  }

  constructor(
    @InjectRepository(Invoice)
    private readonly invoiceRepository: Repository<Invoice>,
    @InjectRepository(ServiceOrder)
    private readonly serviceOrderRepository: Repository<ServiceOrder>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(TechnicianAssignment)
    private readonly assignmentRepository: Repository<TechnicianAssignment>,
    @InjectRepository(CashSettlement)
    private readonly cashSettlementRepository: Repository<CashSettlement>,
    @InjectRepository(CommissionDue)
    private readonly commissionDueRepository: Repository<CommissionDue>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(PlatformDue)
    private readonly platformDueRepository: Repository<PlatformDue>,
    private readonly dataSource: DataSource,
    private readonly configService: BusinessConfigService,
    private readonly supportCasesService: SupportCasesService,
    private readonly auditLogService: AuditLogService,
    @Inject(PAYMENT_VERIFICATION_PORT)
    private readonly paymentVerificationPort: PaymentVerificationPort,
    private readonly config: ConfigService,
    private readonly httpService: HttpService,
    @Optional() @Inject(forwardRef(() => SettlementService)) private readonly settlementService?: SettlementService,
    @Optional() @Inject(forwardRef(() => WalletService)) private readonly walletService?: WalletService,
    @Optional() private readonly customerWalletService?: CustomerWalletService,
    @Optional() private readonly vouchersService?: VouchersService,
  ) {}

  async getInvoice(
    orderId: string,
    actor: FinanceActor,
  ): Promise<InvoiceResponseDto | null> {
    const order = await this.serviceOrderRepository.findOneBy({ id: orderId });
    if (!order) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Invoice not found');
    }
    await this.assertOrderAccess(order, actor);

    const invoice = await this.invoiceRepository.findOne({
      where: { serviceOrderId: orderId },
      relations: ['items'],
    });
    return invoice ? toInvoiceResponse(invoice) : null;
  }

  async initiateInvoicePayment(
    invoiceId: string,
    actor: FinanceActor,
    dto: InitiatePaymentDto,
  ): Promise<PaymentResponseDto> {
    if (actor.role !== Role.CUSTOMER) {
      throw new BusinessException(
        ErrorCodes.OWNERSHIP_DENIED,
        'Only the invoice customer can initiate payment',
      );
    }

    const mode = await this.getPaymentMode();
    const payment = await this.dataSource.transaction(async (manager) => {
      const invoiceRepository = manager.getRepository(Invoice);
      const paymentRepository = manager.getRepository(Payment);
      const invoice = await invoiceRepository.findOne({
        where: { id: invoiceId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!invoice) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Invoice not found');
      }

      const existing = await paymentRepository.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
        lock: { mode: 'pessimistic_write' },
      });
      if (existing) {
        if (
          existing.invoiceId !== invoice.id ||
          existing.purpose !== PaymentPurpose.INVOICE ||
          existing.requestedByUserId !== actor.id
        ) {
          throw new BusinessException(
            ErrorCodes.PAYMENT_IDEMPOTENCY_CONFLICT,
            'Idempotency key is already bound to another payment',
          );
        }
        return existing;
      }

      if (invoice.paymentStatus === PaymentStatus.PAID) {
        throw new BusinessException(
          ErrorCodes.CONFLICT,
          'Invoice is already paid; no new payment attempt was created',
        );
      }

      const order = await manager.findOne(ServiceOrder, {
        where: { id: invoice.serviceOrderId },
      });
      if (!order) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Service order not found');
      }
      if (order.status === ServiceOrderStatus.CANCELLED) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Đơn đã huỷ, không thanh toán hoá đơn này được');
      }
      const booking = await manager.findOne(Booking, {
        where: { id: order.bookingId },
      });
      if (!booking || booking.customerId !== actor.id) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Invoice not found');
      }
      this.refuseVisitInvoice(booking);

      if (this.requireWholeVnd(invoice.grandTotal, 'Invoice amount') <= 0) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Hóa đơn 0 ₫ cần được xác nhận miễn phí.');
      }
      await this.assertNoActiveCashIntent(manager, 'SOLO', order.id);
      await this.assertNewCollectionAllowed(manager, order.id);

      const payment = paymentRepository.create({
        invoiceId: invoice.id,
        commissionDueId: null,
        purpose: PaymentPurpose.INVOICE,
        amount: this.requireWholeVnd(invoice.grandTotal, 'Invoice amount'),
        currency: 'VND',
        mode,
        provider: null,
        status: PaymentAttemptStatus.PENDING,
        idempotencyKey: dto.idempotencyKey,
        requestedByUserId: actor.id,
        failureCode: null,
        requestedAt: new Date(),
        verifiedAt: null,
      });
      return paymentRepository.save(payment);
    });

    const effectiveMode = payment.mode;
    if (payment.status !== PaymentAttemptStatus.PENDING) {
      return toPaymentResponse(payment);
    }
    if (effectiveMode === PaymentMode.DEMO) {
      return toPaymentResponse(payment);
    }

    const verification = await this.verifyPayment({
      amount: Number(payment.amount),
      currency: 'VND',
      mode: effectiveMode,
      purpose: PaymentPurpose.INVOICE,
      invoiceId: payment.invoiceId,
    });
    const applied = await this.applyVerification(payment, verification, effectiveMode);
    if (applied.status === PaymentAttemptStatus.FAILED) {
      throw new BusinessException(
        applied.failureCode === ErrorCodes.PAYMENT_AMOUNT_MISMATCH
          ? ErrorCodes.PAYMENT_AMOUNT_MISMATCH
          : ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Payment verification failed; the invoice was not marked paid',
      );
    }
    return toPaymentResponse(applied);
  }

  private async createVoucherVnpayUrl(
    scopeKind: VoucherFundingScopeKind, scopeOrInvoiceId: string, actor: FinanceActor,
    ipAddr: string, platform: 'web' | 'mobile', webOrigin: string | undefined,
    reservationId: string,
  ): Promise<{ paymentUrl: string }> {
    if ((await this.getPaymentMode()) !== PaymentMode.LIVE) {
      throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Payment mode is not LIVE');
    }
    const tmnCode = this.config.get<string>('VNPAY_TMN_CODE');
    const hashSecret = this.config.get<string>('VNPAY_HASH_SECRET');
    const paymentUrl = this.config.get<string>('VNPAY_PAYMENT_URL');
    const returnUrl = this.config.get<string>('VNPAY_RETURN_URL');
    if (!tmnCode || !hashSecret || !paymentUrl || !returnUrl) {
      throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'VNPay is not configured');
    }
    const payment = await this.dataSource.transaction(async manager => {
      const invoiceReference = scopeKind === 'SOLO'
        ? await manager.findOneBy(Invoice, { id: scopeOrInvoiceId }) : null;
      if (scopeKind === 'SOLO' && !invoiceReference) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Invoice not found');
      }
      const scopeId = invoiceReference?.serviceOrderId ?? scopeOrInvoiceId;
      const quote = await this.quoteVoucherRail(manager, { reservationId,
        customerId: actor.id, scopeId, scopeKind, rail: 'VNPAY',
        invoiceId: invoiceReference?.id });
      let allocations: ReturnType<typeof allocateFundedVisitCharge>['allocations'] | undefined;
      if (scopeKind === 'SOLO') {
        const invoice = await manager.findOne(Invoice, {
          where: { id: scopeOrInvoiceId }, lock: { mode: 'pessimistic_write' },
        });
        const order = invoice && await manager.findOneBy(ServiceOrder, { id: invoice.serviceOrderId });
        const booking = order && await manager.findOneBy(Booking, { id: order.bookingId });
        if (!invoice || !order || !booking || booking.customerId !== actor.id || booking.visitGroupId ||
            invoice.serviceOrderId !== scopeId || invoice.paymentStatus === PaymentStatus.PAID ||
            Number(invoice.grandTotal) !== quote.total.originalGrossVnd ||
            order.status === ServiceOrderStatus.CANCELLED) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Hóa đơn đã thay đổi.');
        }
      } else {
        await this.visitAccess(manager, scopeId, actor, true);
        allocations = allocateFundedVisitCharge(await this.readyVisitCharge(manager, scopeId), quote).allocations;
      }
      await this.assertNoStoppedCollection(manager, scopeId, scopeKind);
      await this.assertNoActiveCashIntent(manager, scopeKind, scopeId);
      const now = new Date();
      const txnRef = randomUUID().replace(/-/g, '');
      const amount = quote.total.customerDueVnd;
      const saved = scopeKind === 'SOLO'
        ? await manager.save(Payment, manager.create(Payment, {
          invoiceId: scopeOrInvoiceId, commissionDueId: null, purpose: PaymentPurpose.INVOICE,
          amount, currency: 'VND', mode: PaymentMode.LIVE, provider: 'vnpay',
          status: PaymentAttemptStatus.PENDING, idempotencyKey: txnRef,
          requestedByUserId: actor.id, failureCode: null, requestedAt: now, verifiedAt: null,
        }))
        : await manager.save(VisitGroupPayment, manager.create(VisitGroupPayment, {
          visitGroupId: scopeId, rail: 'vnpay', status: 'pending', amount, allocations,
          idempotencyKey: txnRef, requestedByUserId: actor.id, requestedAt: now,
        }));
      await this.bindVoucherPaymentAfterRecord(manager, { reservationId, rail: 'VNPAY',
        sourceId: saved.id, customerId: actor.id, scopeId, scopeKind });
      return saved;
    });
    return { paymentUrl: buildPaymentUrl({ paymentUrl, tmnCode, hashSecret,
      amount: Number(payment.amount), txnRef: payment.idempotencyKey,
      orderInfo: `Thanh toan ${scopeKind === 'SOLO' ? 'hoa don' : 'luot sua'} ${scopeOrInvoiceId}${platform === 'mobile' ? ' mobile' : ''}`,
      returnUrl: platform === 'web' ? withWebOrigin(returnUrl, webOrigin) : returnUrl,
      ipAddr, createdAt: payment.requestedAt }) };
  }

  async createVnpayPaymentUrl(
    invoiceId: string,
    actor: FinanceActor,
    ipAddr: string,
    platform: 'web' | 'mobile' = 'web',
    webOrigin?: string,
    voucherReservationId?: string,
  ): Promise<{ paymentUrl: string }> {
    if (actor.role !== Role.CUSTOMER) {
      throw new BusinessException(
        ErrorCodes.OWNERSHIP_DENIED,
        'Only the invoice customer can initiate payment',
      );
    }
    if (voucherReservationId !== undefined) return this.createVoucherVnpayUrl('SOLO', invoiceId, actor, ipAddr, platform, webOrigin, voucherReservationId);
    if ((await this.getPaymentMode()) !== PaymentMode.LIVE) {
      throw new BusinessException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Payment mode is not LIVE',
      );
    }
    const tmnCode = this.config.get<string>('VNPAY_TMN_CODE');
    const hashSecret = this.config.get<string>('VNPAY_HASH_SECRET');
    const vnpayPaymentUrl = this.config.get<string>('VNPAY_PAYMENT_URL');
    const returnUrl = this.config.get<string>('VNPAY_RETURN_URL');
    if (!tmnCode || !hashSecret || !vnpayPaymentUrl || !returnUrl) {
      throw new BusinessException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'VNPay is not configured',
      );
    }

    const payment = await this.dataSource.transaction(async (manager) => {
      const invoiceRepository = manager.getRepository(Invoice);
      const paymentRepository = manager.getRepository(Payment);
      const invoice = await invoiceRepository.findOne({
        where: { id: invoiceId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!invoice) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Invoice not found');
      }
      if (invoice.paymentStatus === PaymentStatus.PAID) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Invoice is already paid');
      }
      const order = await manager.findOne(ServiceOrder, {
        where: { id: invoice.serviceOrderId },
      });
      if (!order) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Service order not found');
      }
      if (order.status === ServiceOrderStatus.CANCELLED) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Đơn đã huỷ, không thanh toán hoá đơn này được');
      }
      const booking = await manager.findOne(Booking, {
        where: { id: order.bookingId },
      });
      if (!booking || booking.customerId !== actor.id) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Invoice not found');
      }
      this.refuseVisitInvoice(booking);

      if (this.requireWholeVnd(invoice.grandTotal, 'Invoice amount') < 5000) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'VNPay chỉ áp dụng cho hóa đơn từ 5.000 ₫. Vui lòng chọn ví hoặc tiền mặt.');
      }
      await this.assertNoActiveCashIntent(manager, 'SOLO', order.id);
      await this.assertNewCollectionAllowed(manager, order.id);
      const txnRef = randomUUID().replace(/-/g, '');
      const created = paymentRepository.create({
        invoiceId: invoice.id,
        commissionDueId: null,
        purpose: PaymentPurpose.INVOICE,
        amount: this.requireWholeVnd(invoice.grandTotal, 'Invoice amount'),
        currency: 'VND',
        mode: PaymentMode.LIVE,
        provider: 'vnpay',
        status: PaymentAttemptStatus.PENDING,
        idempotencyKey: txnRef,
        requestedByUserId: actor.id,
        failureCode: null,
        requestedAt: new Date(),
        verifiedAt: null,
      });
      return paymentRepository.save(created);
    });

    return {
      paymentUrl: buildPaymentUrl({
        paymentUrl: vnpayPaymentUrl,
        tmnCode,
        hashSecret,
        amount: Number(payment.amount),
        txnRef: payment.idempotencyKey,
        // The "mobile" marker survives the VNPay round trip so the return leg can deep-link back to the app.
        orderInfo: `Thanh toan hoa don ${payment.invoiceId}${platform === 'mobile' ? ' mobile' : ''}`,
        returnUrl: platform === 'web' ? withWebOrigin(returnUrl, webOrigin) : returnUrl,
        ipAddr,
        // The querydr reconciliation sends requestedAt as vnp_TransactionDate; VNPay only finds the
        // payment when it equals the vnp_CreateDate the payment was opened with. A fresh new Date()
        // here could fall in the next second, and then a payment whose IPN never arrived stayed
        // unpaid (and the technician uncredited) although the customer had paid (PO 18/10/2026).
        createdAt: payment.requestedAt,
      }),
    };
  }

  async createWalletTopUpVnpayUrl(
    technicianId: string,
    amount: number,
    ipAddr: string,
    idempotencyKey?: string,
    platform: 'web' | 'mobile' = 'web',
    owner: 'technician' | 'customer' = 'technician',
    webOrigin?: string,
  ): Promise<{ paymentId: string; paymentUrl: string }> {
    const wholeAmount = this.requireWholeVnd(amount, 'Top up amount');
    if (wholeAmount < 10000 || wholeAmount > 50000000) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Số tiền nạp ví phải từ 10.000 ₫ đến 50.000.000 ₫',
      );
    }

    const tmnCode = this.config.get<string>('VNPAY_TMN_CODE');
    const hashSecret = this.config.get<string>('VNPAY_HASH_SECRET');
    const vnpayPaymentUrl = this.config.get<string>('VNPAY_PAYMENT_URL');
    const returnUrl = this.config.get<string>('VNPAY_RETURN_URL');
    if (!tmnCode || !hashSecret || !vnpayPaymentUrl || !returnUrl) {
      throw new BusinessException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'VNPay is not configured',
      );
    }

    const txnRef = idempotencyKey?.trim() || randomUUID().replace(/-/g, '');
    const payment = await this.dataSource.transaction(async (manager) => {
      const paymentRepository = manager.getRepository(Payment);
      const existing = await paymentRepository.findOne({
        where: { idempotencyKey: txnRef },
        lock: { mode: 'pessimistic_write' },
      });
      if (existing) {
        if (
          existing.requestedByUserId !== technicianId ||
          existing.purpose !== PaymentPurpose.WALLET_TOP_UP
        ) {
          throw new BusinessException(
            ErrorCodes.PAYMENT_IDEMPOTENCY_CONFLICT,
            'Idempotency key is already bound to another payment',
          );
        }
        return existing;
      }

      const created = paymentRepository.create({
        invoiceId: null,
        commissionDueId: null,
        purpose: PaymentPurpose.WALLET_TOP_UP,
        amount: wholeAmount,
        currency: 'VND',
        mode: PaymentMode.LIVE,
        provider: 'vnpay',
        status: PaymentAttemptStatus.PENDING,
        idempotencyKey: txnRef,
        requestedByUserId: technicianId,
        failureCode: null,
        requestedAt: new Date(),
        verifiedAt: null,
      });
      return paymentRepository.save(created);
    });

    const who = owner === 'customer' ? 'Nap vi khach FixHome' : 'Nap tien vi FixHome';
    const orderInfo =
      platform === 'mobile'
        ? `${who} mobile ${payment.idempotencyKey.substring(0, 16)}`
        : `${who} ${payment.idempotencyKey.substring(0, 16)}`;

    return {
      paymentId: payment.id,
      paymentUrl: buildPaymentUrl({
        paymentUrl: vnpayPaymentUrl,
        tmnCode,
        hashSecret,
        amount: Number(payment.amount),
        txnRef: payment.idempotencyKey,
        orderInfo,
        returnUrl: platform === 'web' ? withWebOrigin(returnUrl, webOrigin) : returnUrl,
        ipAddr: ipAddr || '127.0.0.1',
        // querydr finds a transaction by the create date it was opened with.
        createdAt: payment.requestedAt,
      }),
    };
  }

  /** VNPay server-to-server notification — the sole source of truth for marking an invoice paid. */
  async handleVnpayIpn(
    query: Record<string, string>,
  ): Promise<{ RspCode: string; Message: string }> {
    const hashSecret = this.config.get<string>('VNPAY_HASH_SECRET');
    if (!hashSecret || !verifySignature(query, hashSecret)) {
      return { RspCode: '97', Message: 'Invalid signature' };
    }
    const payment = await this.paymentRepository.findOne({
      where: { idempotencyKey: query.vnp_TxnRef, provider: 'vnpay' },
    });
    if (!payment) {
      // Not an invoice payment: perhaps one for a whole visit of several devices.
      return this.handleVisitVnpayIpn(query);
    }
    const fundedLink = await this.findOptionalVoucherPaymentLink({ paymentId: payment.id });
    if (fundedLink) return this.handleVoucherVnpayIpn(fundedLink.reservationId, query);
    if (payment.status !== PaymentAttemptStatus.PENDING) {
      return { RspCode: '02', Message: 'Order already confirmed' };
    }
    const vnpAmount = Number(query.vnp_Amount) / 100;
    if (!Number.isSafeInteger(vnpAmount) || vnpAmount !== Number(payment.amount)) {
      return { RspCode: '04', Message: 'Invalid amount' };
    }

    if (query.vnp_ResponseCode === '00' && query.vnp_TransactionStatus === '00') {
      await this.applyVerification(
        payment,
        {
          outcome: 'verified',
          amount: vnpAmount,
          currency: 'VND',
          providerReference: query.vnp_TransactionNo || query.vnp_TxnRef,
        },
        PaymentMode.LIVE,
      );
    } else {
      await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(Payment);
        const current = await repository.findOne({
          where: { id: payment.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (current && current.status === PaymentAttemptStatus.PENDING) {
          current.status = PaymentAttemptStatus.FAILED;
          current.failureCode = `VNPAY_${query.vnp_ResponseCode ?? 'UNKNOWN'}`;
          await repository.save(current);
        }
      });
    }
    return { RspCode: '00', Message: 'Confirm Success' };
  }

  /** Persist signed provider proof first so an invoice conflict cannot erase a paid callback. */
  private async handleVoucherVnpayIpn(reservationId: string, query: Record<string, string>): Promise<{ RspCode: string; Message: string }> {
    const merchantCode = this.config.get<string>('VNPAY_TMN_CODE');
    const hashSecret = this.config.get<string>('VNPAY_HASH_SECRET');
    if (!merchantCode || !hashSecret || !this.vouchersService) {
      return { RspCode: '99', Message: 'Funding unavailable' };
    }
    const outcome = await this.dataSource.transaction(async manager => {
      const decision = await recordSignedVoucherVnpayOutcome(manager, reservationId, query, merchantCode, hashSecret);
      if (decision.decision === 'RELEASE') {
        const link = await manager.findOneBy(VoucherPaymentLink, { reservationId });
        if (link?.paymentId) await manager.update(Payment,
          { id: link.paymentId, status: PaymentAttemptStatus.PENDING },
          { status: PaymentAttemptStatus.FAILED, failureCode: `VNPAY_${query.vnp_ResponseCode ?? 'UNKNOWN'}` });
        if (link?.visitGroupPaymentId) await manager.update(VisitGroupPayment,
          { id: link.visitGroupPaymentId, status: 'pending' },
          { status: 'failed', failureCode: `VNPAY_${query.vnp_ResponseCode ?? 'UNKNOWN'}` });
      }
      return decision;
    });
    if (outcome.decision !== 'SETTLE' || !outcome.providerPaidAt || !outcome.providerReference) {
      return { RspCode: '00', Message: 'Evidence retained' };
    }
    try {
      await this.dataSource.transaction(async manager => {
        await lockVoucherFundingReservation(manager, reservationId);
        const link = await manager.findOne(VoucherPaymentLink, { where: { reservationId }, lock: { mode: 'pessimistic_write' } });
        if (!link || link.rail !== 'VNPAY' || link.providerTxnRef !== query.vnp_TxnRef ||
            link.customerDueVnd !== Number(query.vnp_Amount) / 100) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Thanh toán ưu đãi không khớp.');
        }
        const paidAt = outcome.providerPaidAt!;
        const providerReference = outcome.providerReference!;
        if (link.scopeKind === 'SOLO' && link.paymentId) {
          const payment = await manager.findOne(Payment, { where: { id: link.paymentId }, lock: { mode: 'pessimistic_write' } });
          if (!payment || payment.status === PaymentAttemptStatus.VERIFIED) return;
          if (payment.status !== PaymentAttemptStatus.PENDING || !payment.invoiceId) {
            throw new BusinessException(ErrorCodes.CONFLICT, 'Payment attempt changed.');
          }
          const invoice = await manager.findOne(Invoice, { where: { id: payment.invoiceId }, lock: { mode: 'pessimistic_write' } });
          if (!invoice || invoice.paymentStatus === PaymentStatus.PAID ||
              Number(invoice.grandTotal) !== link.allocationSnapshot[0]?.originalGrossVnd) {
            throw new BusinessException(ErrorCodes.CONFLICT, 'Invoice changed after provider payment.');
          }
          payment.status = PaymentAttemptStatus.VERIFIED;
          payment.providerReference = providerReference;
          payment.verifiedAt = paidAt;
          await manager.save(Payment, payment);
          await this.markInvoicePaidOnline(manager, invoice, payment.requestedByUserId, paidAt);
          await commitVerifiedVoucherFunding(manager, payment.id);
          await this.vouchersService!.redeemSettled(payment.id, manager);
        } else if (link.scopeKind === 'VISIT_GROUP' && link.visitGroupPaymentId) {
          const payment = await manager.findOne(VisitGroupPayment, { where: { id: link.visitGroupPaymentId }, lock: { mode: 'pessimistic_write' } });
          if (!payment || payment.status === 'verified') return;
          if (payment.status !== 'pending' || payment.allocations.length !== link.allocationSnapshot.length) {
            throw new BusinessException(ErrorCodes.CONFLICT, 'Visit payment changed.');
          }
          const due = new Map(link.allocationSnapshot.map(item => [item.invoiceId, item.customerDueVnd]));
          for (const allocation of payment.allocations) {
            const snapshot = link.allocationSnapshot.find(item => item.invoiceId === allocation.invoiceId);
            const invoice = await manager.findOne(Invoice, { where: { id: allocation.invoiceId }, lock: { mode: 'pessimistic_write' } });
            if (!snapshot || !invoice || invoice.paymentStatus === PaymentStatus.PAID ||
                invoice.serviceOrderId !== allocation.serviceOrderId ||
                Number(invoice.grandTotal) !== snapshot.originalGrossVnd ||
                Number(allocation.amount) !== due.get(allocation.invoiceId)) {
              throw new BusinessException(ErrorCodes.CONFLICT, 'Visit invoices changed after provider payment.');
            }
            await manager.save(Payment, manager.create(Payment, {
              invoiceId: invoice.id, commissionDueId: null, purpose: PaymentPurpose.INVOICE,
              amount: allocation.amount, currency: 'VND', mode: PaymentMode.LIVE,
              provider: 'vnpay', status: PaymentAttemptStatus.VERIFIED,
              idempotencyKey: `${payment.idempotencyKey}:${invoice.id}`,
              providerReference: `${providerReference}:${invoice.id}`.slice(0, 255),
              requestedByUserId: payment.requestedByUserId,
              failureCode: null, requestedAt: payment.requestedAt, verifiedAt: paidAt,
            }));
            await this.markInvoicePaidOnline(manager, invoice, payment.requestedByUserId, paidAt);
          }
          payment.status = 'verified';
          payment.verifiedAt = paidAt;
          payment.providerReference = providerReference;
          await manager.save(VisitGroupPayment, payment);
          await this.cancelOpenVisitPayments(manager, payment.visitGroupId, 'PAID_BY_VNPAY', payment.id);
          await commitVerifiedVoucherFunding(manager, payment.id);
          await this.vouchersService!.redeemSettled(payment.id, manager);
        } else {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Voucher payment link changed.');
        }
      });
    } catch (error) {
      this.logger.error(`Voucher provider payment held for reconciliation: ${(error as Error).message}`);
      return { RspCode: '99', Message: 'Funding reconciliation required' };
    }
    return { RspCode: '00', Message: 'Confirm Success' };
  }

  /**
   * Browser return leg. Does not trust the redirect alone to mark anything paid — but
   * since IPN is an async webhook that a non-public backend (e.g. localhost in local
   * dev, or a slow network in prod) may never receive, this also makes one best-effort
   * server-to-server "querydr" call to VNPay to reconcile the payment immediately, using
   * the exact same `applyVerification` authority path as the IPN handler above.
   */
  async handleVnpayReturn(
    query: Record<string, string>,
  ): Promise<{
    ok: boolean;
    invoiceId: string | null;
    serviceOrderId: string | null;
    /** Set for a visit payment of several devices (PO 21/10/2026). */
    visitGroupId?: string;
    purpose?: PaymentPurpose;
    amount?: number;
    orderInfo?: string;
    payerRole?: string;
  }> {
    const hashSecret = this.config.get<string>('VNPAY_HASH_SECRET');
    if (!hashSecret || !verifySignature(query, hashSecret)) {
      return { ok: false, invoiceId: null, serviceOrderId: null };
    }
    const payment = await this.paymentRepository.findOne({
      where: { idempotencyKey: query.vnp_TxnRef, provider: 'vnpay' },
    });
    if (!payment) {
      return this.handleVisitVnpayReturn(query, hashSecret);
    }
    if (query.vnp_ResponseCode === '00' && payment.status === PaymentAttemptStatus.PENDING) {
      await this.reconcileVnpayPayment(payment, hashSecret).catch((error) => {
        this.logger.warn(`VNPay querydr reconciliation failed: ${(error as Error)?.message}`);
      });
    }
    const invoice = payment.invoiceId
      ? await this.invoiceRepository.findOneBy({ id: payment.invoiceId })
      : null;
    const payer = payment.requestedByUserId
      ? await this.dataSource.getRepository(User).findOne({ where: { id: payment.requestedByUserId }, select: { id: true, role: true } })
      : null;
    return {
      ok: query.vnp_ResponseCode === '00',
      invoiceId: payment.invoiceId ?? null,
      serviceOrderId: invoice?.serviceOrderId ?? null,
      purpose: payment.purpose,
      amount: Number(payment.amount),
      orderInfo: query.vnp_OrderInfo,
      payerRole: payer?.role,
    };
  }

  /** Best-effort synchronous reconciliation for the return leg; IPN remains authoritative for async delivery. */
  private async reconcileVnpayPayment(payment: Payment, hashSecret: string): Promise<void> {
    const tmnCode = this.config.get<string>('VNPAY_TMN_CODE');
    const queryDrUrl = this.config.get<string>('VNPAY_QUERYDR_URL');
    if (!tmnCode || !queryDrUrl) return;
    const orderInfo =
      payment.purpose === PaymentPurpose.WALLET_TOP_UP
        ? `Nap tien vi FixHome ${payment.idempotencyKey.substring(0, 16)}`
        : `Thanh toan hoa don ${payment.invoiceId ?? payment.idempotencyKey}`;
    const body = buildQueryDrRequest({
      tmnCode,
      hashSecret,
      txnRef: payment.idempotencyKey,
      orderInfo,
      transactionDate: payment.requestedAt,
      ipAddr: '127.0.0.1',
    });
    const response = await firstValueFrom(
      this.httpService.post(queryDrUrl, body).pipe(timeout(8000)),
    );
    const data = response.data as Record<string, string>;
    if (data?.vnp_ResponseCode === '00' && data?.vnp_TransactionStatus === '00') {
      const fundedLink = await this.findOptionalVoucherPaymentLink({ paymentId: payment.id });
      if (fundedLink) {
        // Querydr can close a funded payment only with the same signed PayDate proof as an IPN.
        await this.handleVnpayIpn(data);
        return;
      }
      const vnpAmount = Number(data.vnp_Amount) / 100;
      await this.applyVerification(
        payment,
        {
          outcome: 'verified',
          amount: vnpAmount,
          currency: 'VND',
          providerReference: data.vnp_TransactionNo || payment.idempotencyKey,
        },
        PaymentMode.LIVE,
      );
    }
  }

  private async declareVoucherCash(orderId: string, dto: CashSettlementDeclarationDto,
    actor: FinanceActor, reservationId: string): Promise<ReturnType<typeof toCashSettlementResponse>> {
    return this.dataSource.transaction(async manager => {
      const reference = await manager.findOneBy(ServiceOrder, { id: orderId });
      const booking = reference && await manager.findOneBy(Booking, { id: reference.bookingId });
      if (!reference || !booking || booking.visitGroupId) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Order not found');
      }
      const invoiceReference = await manager.findOneBy(Invoice, { serviceOrderId: orderId });
      if (!invoiceReference) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Invoice not found');
      const quote = await this.quoteVoucherRail(manager, { reservationId,
        customerId: booking.customerId, scopeId: orderId, scopeKind: 'SOLO',
        rail: 'CASH', invoiceId: invoiceReference.id });
      const due = quote.total.customerDueVnd;
      if (this.requireWholeVnd(dto.declaredAmount, 'Declared amount') !== due) {
        throw new BusinessException(ErrorCodes.CASH_SETTLEMENT_MISMATCH, 'Số tiền mặt không khớp với số tiền khách cần trả.');
      }
      const order = await manager.findOne(ServiceOrder, { where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
      const assignment = await manager.findOne(TechnicianAssignment, {
        where: { serviceOrderId: orderId, technicianId: actor.id, isActive: true },
      });
      const invoice = await manager.findOne(Invoice, { where: { id: invoiceReference.id }, lock: { mode: 'pessimistic_write' } });
      if (!order || !assignment || !invoice || invoice.serviceOrderId !== orderId ||
          Number(invoice.grandTotal) !== quote.total.originalGrossVnd ||
          invoice.paymentStatus === PaymentStatus.PAID ||
          ![ServiceOrderStatus.UNDER_REPAIR, ServiceOrderStatus.COMPLETED].includes(order.status)) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Hóa đơn đã thay đổi.');
      }
      await this.assertNoStoppedCollection(manager, orderId);
      await this.assertLegacyCashCompatibility(manager, 'SOLO', orderId);
      await lockCustodyTechnician(manager, actor.id);
      const existing = await manager.findOne(CashSettlement, { where: { serviceOrderId: orderId }, lock: { mode: 'pessimistic_write' } });
      if (existing) {
        if (existing.status !== CashSettlementStatus.PENDING_CONFIRMATION ||
            existing.declaredByTechnicianId !== actor.id || Number(existing.declaredAmount) !== due) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Tiền mặt đã được khai báo.');
        }
        await this.bindVoucherPaymentAfterRecord(manager, { reservationId, rail: 'CASH', sourceId: existing.id,
          customerId: booking.customerId, scopeId: orderId, scopeKind: 'SOLO' });
        return toCashSettlementResponse(existing);
      }
      const settlement = await manager.save(CashSettlement, manager.create(CashSettlement, {
        serviceOrderId: orderId, declaredByTechnicianId: actor.id, declaredAmount: due,
        declaredAt: new Date(), status: CashSettlementStatus.PENDING_CONFIRMATION,
        technicianNotes: dto.technicianNotes ?? null, receiptEvidenceUrl: dto.receiptEvidenceUrl ?? null,
        confirmedByCustomerId: null, confirmedAmount: null, confirmedAt: null,
      }));
      await this.bindVoucherPaymentAfterRecord(manager, { reservationId, rail: 'CASH', sourceId: settlement.id,
        customerId: booking.customerId, scopeId: orderId, scopeKind: 'SOLO' });
      return toCashSettlementResponse(settlement);
    });
  }

  private async declareVoucherVisitCash(groupId: string, dto: CashSettlementDeclarationDto,
    actor: FinanceActor, reservationId: string) {
    return this.dataSource.transaction(async manager => {
      const group = await manager.findOneBy(VisitGroup, { id: groupId });
      if (!group) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Visit not found');
      const quote = await this.quoteVoucherRail(manager, { reservationId,
        customerId: group.customerId, scopeId: groupId, scopeKind: 'VISIT_GROUP', rail: 'CASH' });
      await this.visitAccess(manager, groupId, actor, true);
      await lockCustodyTechnician(manager, actor.id);
      const funded = allocateFundedVisitCharge(await this.readyVisitCharge(manager, groupId), quote);
      await this.assertNoStoppedCollection(manager, groupId, 'VISIT_GROUP');
      await this.assertLegacyCashCompatibility(manager, 'VISIT_GROUP', groupId);
      if (this.requireWholeVnd(dto.declaredAmount, 'Declared amount') !== funded.customerDue) {
        throw new BusinessException(ErrorCodes.CASH_SETTLEMENT_MISMATCH, 'Số tiền mặt không khớp với số tiền khách cần trả.');
      }
      const existing = await manager.findOne(VisitGroupPayment, { where: {
        visitGroupId: groupId, rail: 'cash', status: 'pending_confirmation',
      }, lock: { mode: 'pessimistic_write' } });
      if (existing) {
        if (existing.requestedByUserId !== actor.id || Number(existing.amount) !== funded.customerDue ||
            !sameAllocations(existing.allocations, funded.allocations)) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Tiền mặt đã được khai báo.');
        }
        await this.bindVoucherPaymentAfterRecord(manager, { reservationId, rail: 'CASH', sourceId: existing.id,
          customerId: group.customerId, scopeId: groupId, scopeKind: 'VISIT_GROUP' });
        return { id: existing.id, status: existing.status, amount: Number(existing.amount) };
      }
      const payment = await manager.save(VisitGroupPayment, manager.create(VisitGroupPayment, {
        visitGroupId: groupId, rail: 'cash', status: 'pending_confirmation',
        amount: funded.customerDue, allocations: funded.allocations,
        idempotencyKey: `VOUCHER_CASH:${reservationId}`,
        requestedByUserId: actor.id, requestedAt: new Date(),
        providerReference: dto.technicianNotes?.slice(0, 255) ?? null,
      }));
      await this.bindVoucherPaymentAfterRecord(manager, { reservationId, rail: 'CASH', sourceId: payment.id,
        customerId: group.customerId, scopeId: groupId, scopeKind: 'VISIT_GROUP' });
      await manager.insert(Notification, { userId: group.customerId,
        title: 'Xác nhận tiền mặt cho lượt sửa',
        message: 'Kỹ thuật viên đã báo nhận tiền mặt cho cả lượt sửa. Vui lòng kiểm tra số tiền và xác nhận.',
        type: 'VISIT_CASH_DECLARED', referenceType: 'VISIT_GROUP', referenceId: groupId, isRead: false });
      return { id: payment.id, status: payment.status, amount: Number(payment.amount) };
    });
  }

  async declareCashSettlement(
    orderId: string,
    dto: CashSettlementDeclarationDto,
    actor: FinanceActor,
    voucherReservationId?: string,
  ): Promise<ReturnType<typeof toCashSettlementResponse>> {
    if (this.cashFirstEnabled() && !this.legacyCashCompatibilityEnabled()) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Vui lòng chờ khách chọn tiền mặt trước khi xác nhận đã nhận.');
    }
    if (actor.role !== Role.TECHNICIAN) {
      throw new BusinessException(
        ErrorCodes.OWNERSHIP_DENIED,
        'Only the assigned technician can declare cash received',
      );
    }
    if (voucherReservationId !== undefined) return this.declareVoucherCash(orderId, dto, actor, voucherReservationId);

    const result = await this.dataSource.transaction(async (manager) => {
      const orderRepository = manager.getRepository(ServiceOrder);
      const invoiceRepository = manager.getRepository(Invoice);
      const settlementRepository = manager.getRepository(CashSettlement);
      const order = await orderRepository.findOne({
        where: { id: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Service order not found');
      }
      const assignment = await manager.findOne(TechnicianAssignment, {
        where: { serviceOrderId: orderId, technicianId: actor.id, isActive: true },
      });
      if (!assignment) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Order not found');
      }
      this.refuseVisitInvoice(await manager.findOne(Booking, { where: { id: order.bookingId } }));
      // Serializes CASH-COLLECTED self-declaration with new jobs and withdrawal writes.
      await lockCustodyTechnician(manager, actor.id);
      if (
        ![ServiceOrderStatus.UNDER_REPAIR, ServiceOrderStatus.COMPLETED].includes(order.status)
      ) {
        throw new BusinessException(
          ErrorCodes.ORDER_INVALID_TRANSITION,
          'Order must be under repair or completed to declare cash payment',
        );
      }

      const invoice = await invoiceRepository.findOne({
        where: { serviceOrderId: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!invoice) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Invoice not found');
      }
      if (invoice.paymentStatus === PaymentStatus.PAID) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Invoice is already paid');
      }
      await this.assertLegacyCashCompatibility(manager, 'SOLO', orderId);

      if (this.requireWholeVnd(invoice.grandTotal, 'Invoice amount') <= 0) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Hóa đơn 0 ₫ cần được khách hàng xác nhận miễn phí.');
      }
      await this.assertNewCollectionAllowed(manager, order.id);

      let settlement = await settlementRepository.findOne({
        where: { serviceOrderId: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (settlement?.status === CashSettlementStatus.CONFIRMED) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Cash settlement is already confirmed');
      }
      if (settlement?.status === CashSettlementStatus.DISPUTED) {
        throw new BusinessException(
          ErrorCodes.CONFLICT,
          'Disputed cash settlement must be resolved through Support Cases',
        );
      }

      settlement ??= settlementRepository.create({
        serviceOrderId: orderId,
        declaredByTechnicianId: actor.id,
      });
      settlement.declaredByTechnicianId = actor.id;
      settlement.declaredAmount = this.requireWholeVnd(
        dto.declaredAmount,
        'Declared amount',
      );
      settlement.declaredAt = new Date();
      settlement.technicianNotes = dto.technicianNotes ?? null;
      settlement.receiptEvidenceUrl = dto.receiptEvidenceUrl ?? null;
      settlement.confirmedByCustomerId = null;
      settlement.confirmedAmount = null;
      settlement.confirmedAt = null;
      settlement.disputeReason = null;
      settlement.disputedByCustomerId = null;
      settlement.disputedAt = null;

      const mismatch =
        settlement.declaredAmount !==
        this.requireWholeVnd(invoice.grandTotal, 'Invoice amount');
      if (mismatch) {
        const now = new Date();
        settlement.status = CashSettlementStatus.DISPUTED;
        settlement.disputeReason =
          'Technician declaration does not match the server invoice amount';
        settlement.disputedAt = now;
        const savedSettlement = await settlementRepository.save(settlement);
        const booking = await manager.findOne(Booking, {
          where: { id: order.bookingId },
        });
        await this.openCashMismatchCase(
          manager,
          order,
          invoice,
          savedSettlement,
          actor,
          booking?.customerId ?? null,
          null,
        );
        await this.auditLogService.logWithManager(manager, {
          actorUserId: actor.id,
          actorRole: actor.role,
          action: 'CASH_SETTLEMENT_DISPUTED',
          resourceType: 'cash_settlement',
          resourceId: savedSettlement.id,
          after: {
            status: savedSettlement.status,
            expectedAmount: Number(invoice.grandTotal),
            declaredAmount: Number(savedSettlement.declaredAmount),
          },
        });
        return { settlement: savedSettlement, mismatch: true };
      }

      settlement.status = CashSettlementStatus.PENDING_CONFIRMATION;
      const savedSettlement = await settlementRepository.save(settlement);
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'CASH_SETTLEMENT_DECLARED',
        resourceType: 'cash_settlement',
        resourceId: savedSettlement.id,
        after: {
          status: savedSettlement.status,
          amount: Number(savedSettlement.declaredAmount),
        },
      });
      return { settlement: savedSettlement, mismatch: false };
    });

    if (result.mismatch) {
      throw new BusinessException(
        ErrorCodes.CASH_SETTLEMENT_MISMATCH,
        'Declared cash amount does not match the server invoice; support review is required',
      );
    }
    return toCashSettlementResponse(result.settlement);
  }

  private async confirmVoucherCash(orderId: string, dto: CashSettlementConfirmationDto,
    actor: FinanceActor, reservationId: string): Promise<ReturnType<typeof toCashSettlementResponse>> {
    if (!this.walletService || !this.vouchersService) {
      throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Thanh toán ưu đãi chưa sẵn sàng.');
    }
    return this.dataSource.transaction(async manager => {
      await lockVoucherFundingReservation(manager, reservationId);
      const link = await manager.findOneBy(VoucherPaymentLink, { reservationId });
      if (!link || link.rail !== 'CASH' || link.scopeKind !== 'SOLO' ||
          link.scopeId !== orderId || link.customerId !== actor.id || !link.cashSettlementId) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Cash settlement not found');
      }
      const order = await manager.findOne(ServiceOrder, { where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
      const booking = order && await manager.findOneBy(Booking, { id: order.bookingId });
      const invoice = order && await manager.findOne(Invoice, { where: { serviceOrderId: orderId }, lock: { mode: 'pessimistic_write' } });
      const settlement = await manager.findOne(CashSettlement, { where: { id: link.cashSettlementId }, lock: { mode: 'pessimistic_write' } });
      if (!order || !booking || booking.customerId !== actor.id || booking.visitGroupId ||
          !invoice || !settlement || settlement.serviceOrderId !== orderId ||
          Number(invoice.grandTotal) !== link.originalGrossVnd ||
          Number(settlement.declaredAmount) !== link.customerDueVnd) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Cash settlement changed.');
      }
      if (settlement.status === CashSettlementStatus.CONFIRMED) return toCashSettlementResponse(settlement);
      if (settlement.status !== CashSettlementStatus.PENDING_CONFIRMATION ||
          invoice.paymentStatus === PaymentStatus.PAID) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Cash settlement is no longer pending.');
      }
      const agreed = dto.agreed === true &&
        (dto.confirmedAmount === undefined ||
          this.requireWholeVnd(dto.confirmedAmount, 'Confirmed amount') === link.customerDueVnd);
      if (!agreed) {
        settlement.status = CashSettlementStatus.DISPUTED;
        settlement.confirmedByCustomerId = null;
        settlement.confirmedAmount = dto.confirmedAmount === undefined ? null
          : this.requireWholeVnd(dto.confirmedAmount, 'Confirmed amount');
        settlement.confirmedAt = null;
        settlement.disputeReason = dto.disputeReason ?? 'Customer disputed voucher cash amount';
        settlement.disputedByCustomerId = actor.id;
        settlement.disputedAt = new Date();
        await manager.save(CashSettlement, settlement);
        await this.supportCasesService.openCase({
          caseType: SupportCaseType.CASH_MISMATCH,
          reason: 'Tiền mặt sau ưu đãi chưa khớp',
          description: [`Đơn ${orderId}: cần thu ${link.customerDueVnd} VND`,
            `thợ báo ${settlement.declaredAmount} VND`,
            dto.confirmedAmount === undefined ? null : `khách xác nhận ${dto.confirmedAmount} VND`,
            dto.disputeReason ?? null].filter(Boolean).join('; '),
          bookingId: order.bookingId,
          serviceOrderId: order.id,
          customerId: actor.id,
          technicianId: settlement.declaredByTechnicianId,
          createdByUserId: actor.id,
        }, manager);
        return toCashSettlementResponse(settlement);
      }
      const now = new Date();
      settlement.status = CashSettlementStatus.CONFIRMED;
      settlement.confirmedByCustomerId = actor.id;
      settlement.confirmedAmount = link.customerDueVnd;
      settlement.confirmedAt = now;
      settlement.disputeReason = null;
      await manager.save(CashSettlement, settlement);
      await this.applyConfirmedCash(manager, { order, invoice, settlement, actor, now,
        collectedAmount: link.customerDueVnd });
      await commitConfirmedCashVoucherFunding(manager, reservationId, this.walletService!);
      await this.vouchersService!.redeemSettled(settlement.id, manager);
      return toCashSettlementResponse(settlement);
    });
  }

  async confirmVoucherCashByReservation(orderId: string, dto: CashSettlementConfirmationDto,
    actor: FinanceActor, reservationId: string): Promise<ReturnType<typeof toCashSettlementResponse>> {
    if (actor.role !== Role.CUSTOMER) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the customer can confirm cash payment');
    }
    if (this.cashFirstEnabled() && await this.dataSource.getRepository(CashPaymentIntent).exists({
      where: { scopeKind: 'SOLO', scopeId: orderId, status: In(['pending', 'received']) },
    })) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Yêu cầu tiền mặt mới không cần khách xác nhận lần nữa.');
    }
    return this.confirmVoucherCash(orderId, dto, actor, reservationId);
  }

  private async confirmVoucherVisitCash(groupId: string, dto: CashSettlementConfirmationDto,
    actor: FinanceActor, reservationId: string) {
    if (!this.walletService || !this.vouchersService) {
      throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Thanh toán ưu đãi chưa sẵn sàng.');
    }
    return this.dataSource.transaction(async manager => {
      await lockVoucherFundingReservation(manager, reservationId);
      const link = await manager.findOneBy(VoucherPaymentLink, { reservationId });
      if (!link || link.rail !== 'CASH' || link.scopeKind !== 'VISIT_GROUP' ||
          link.scopeId !== groupId || link.customerId !== actor.id || !link.visitGroupPaymentId) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Visit cash settlement not found');
      }
      await this.visitAccess(manager, groupId, actor, true);
      const payment = await manager.findOne(VisitGroupPayment, {
        where: { id: link.visitGroupPaymentId }, lock: { mode: 'pessimistic_write' },
      });
      if (!payment || payment.visitGroupId !== groupId || payment.rail !== 'cash' ||
          Number(payment.amount) !== link.customerDueVnd) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Visit cash settlement changed.');
      }
      if (payment.status === 'verified') return { id: payment.id, status: payment.status, amount: Number(payment.amount) };
      if (payment.status !== 'pending_confirmation') {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Visit cash settlement is no longer pending.');
      }
      const funded = allocateFundedVisitCharge(await this.readyVisitCharge(manager, groupId), {
        invoices: link.allocationSnapshot, total: { originalGrossVnd: link.originalGrossVnd,
          customerDueVnd: link.customerDueVnd } as VoucherFundingAllocation['total'],
      });
      if (!sameAllocations(payment.allocations, funded.allocations) ||
          dto.agreed !== true ||
          (dto.confirmedAmount !== undefined &&
            this.requireWholeVnd(dto.confirmedAmount, 'Confirmed amount') !== link.customerDueVnd)) {
        payment.status = 'disputed';
        payment.failureCode = 'CUSTOMER_DISPUTED';
        await manager.save(VisitGroupPayment, payment);
        const first = payment.allocations[0];
        const order = first && await manager.findOneBy(ServiceOrder, { id: first.serviceOrderId });
        await this.supportCasesService.openCase({
          caseType: SupportCaseType.CASH_MISMATCH,
          reason: 'Tiền mặt của lượt sửa nhiều máy chưa khớp',
          description: [`Lượt ${groupId}: thợ báo ${link.customerDueVnd} VND`,
            dto.confirmedAmount === undefined ? null : `khách xác nhận ${dto.confirmedAmount} VND`,
            dto.disputeReason ?? null].filter(Boolean).join('; '),
          bookingId: order?.bookingId ?? null,
          serviceOrderId: order?.id ?? null,
          customerId: actor.id,
          technicianId: payment.requestedByUserId,
          createdByUserId: actor.id,
        }, manager);
        return { id: payment.id, status: payment.status, amount: Number(payment.amount) };
      }
      const now = new Date();
      for (const allocation of payment.allocations) {
        const order = await manager.findOneOrFail(ServiceOrder, { where: { id: allocation.serviceOrderId }, lock: { mode: 'pessimistic_write' } });
        const invoice = await manager.findOneOrFail(Invoice, { where: { id: allocation.invoiceId } });
        const settlement = await manager.save(CashSettlement, manager.create(CashSettlement, {
          serviceOrderId: order.id, declaredByTechnicianId: payment.requestedByUserId,
          declaredAmount: allocation.amount, declaredAt: payment.requestedAt,
          status: CashSettlementStatus.CONFIRMED, confirmedByCustomerId: actor.id,
          confirmedAmount: allocation.amount, confirmedAt: now,
          technicianNotes: `Thu chung lượt sửa ${groupId}`,
        }));
        await this.applyConfirmedCash(manager, { order, invoice, settlement, actor, now,
          collectedAmount: allocation.amount });
      }
      payment.status = 'verified';
      payment.verifiedAt = now;
      await manager.save(VisitGroupPayment, payment);
      await this.cancelOpenVisitPayments(manager, groupId, 'CASH_CONFIRMED', payment.id);
      await commitConfirmedCashVoucherFunding(manager, reservationId, this.walletService!);
      await this.vouchersService!.redeemSettled(payment.id, manager);
      return { id: payment.id, status: payment.status, amount: Number(payment.amount) };
    });
  }

  async confirmVoucherVisitCashByReservation(groupId: string, dto: CashSettlementConfirmationDto,
    actor: FinanceActor, reservationId: string) {
    if (actor.role !== Role.CUSTOMER) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the customer can confirm cash payment');
    }
    if (this.cashFirstEnabled() && await this.dataSource.getRepository(CashPaymentIntent).exists({
      where: { scopeKind: 'VISIT_GROUP', scopeId: groupId, status: In(['pending', 'received']) },
    })) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Yêu cầu tiền mặt mới không cần khách xác nhận lần nữa.');
    }
    return this.confirmVoucherVisitCash(groupId, dto, actor, reservationId);
  }

  async confirmCashSettlement(
    orderId: string,
    dto: CashSettlementConfirmationDto,
    actor: FinanceActor,
  ): Promise<ReturnType<typeof toCashSettlementResponse>> {
    if (actor.role !== Role.CUSTOMER) {
      throw new BusinessException(
        ErrorCodes.OWNERSHIP_DENIED,
        'Only the invoice customer can confirm cash payment',
      );
    }

    if (this.cashFirstEnabled() && await this.dataSource.getRepository(CashPaymentIntent).exists({
      where: { scopeKind: 'SOLO', scopeId: orderId, status: In(['pending', 'received']) },
    })) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Yêu cầu tiền mặt mới không cần khách xác nhận lần nữa.');
    }

    const fundedCash = await this.dataSource.getRepository(CashSettlement).findOneBy({ serviceOrderId: orderId });
    if (fundedCash) {
      const link = await this.findOptionalVoucherPaymentLink({ cashSettlementId: fundedCash.id });
      if (link) return this.confirmVoucherCash(orderId, dto, actor, link.reservationId);
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const orderRepository = manager.getRepository(ServiceOrder);
      const invoiceRepository = manager.getRepository(Invoice);
      const settlementRepository = manager.getRepository(CashSettlement);
      const order = await orderRepository.findOne({
        where: { id: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Service order not found');
      }
      const booking = await manager.findOne(Booking, {
        where: { id: order.bookingId },
      });
      if (!booking || booking.customerId !== actor.id) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Order not found');
      }
      this.refuseVisitInvoice(booking);
      const invoice = await invoiceRepository.findOne({
        where: { serviceOrderId: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!invoice) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Invoice not found');
      }
      const settlement = await settlementRepository.findOne({
        where: { serviceOrderId: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!settlement) {
        throw new BusinessException(
          ErrorCodes.NOT_FOUND,
          'No cash settlement declaration found for this order',
        );
      }
      if (settlement.status === CashSettlementStatus.CONFIRMED) {
        return { settlement, mismatch: false };
      }
      if (invoice.paymentStatus === PaymentStatus.PAID) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Invoice is already paid');
      }
      if (settlement.status === CashSettlementStatus.DISPUTED) {
        throw new BusinessException(
          ErrorCodes.CONFLICT,
          'Disputed cash settlement must be resolved through Support Cases',
        );
      }

      const invoiceAmount = this.requireWholeVnd(invoice.grandTotal, 'Invoice amount');
      await this.assertLegacyCollectionAllowed(manager, order.id);
      const declaredAmount = this.requireWholeVnd(
        settlement.declaredAmount,
        'Declared amount',
      );
      const confirmedAmount =
        dto.confirmedAmount === undefined
          ? null
          : this.requireWholeVnd(dto.confirmedAmount, 'Confirmed amount');
      const exactMatch =
        dto.agreed === true &&
        declaredAmount === invoiceAmount &&
        (confirmedAmount === null || confirmedAmount === invoiceAmount);

      if (!exactMatch) {
        const now = new Date();
        settlement.status = CashSettlementStatus.DISPUTED;
        settlement.confirmedByCustomerId = null;
        settlement.confirmedAmount = confirmedAmount;
        settlement.confirmedAt = null;
        settlement.disputeReason =
          dto.disputeReason ?? 'Customer disputed the cash settlement amount';
        settlement.disputedByCustomerId = actor.id;
        settlement.disputedAt = now;
        const savedSettlement = await settlementRepository.save(settlement);
        await this.openCashMismatchCase(
          manager,
          order,
          invoice,
          savedSettlement,
          actor,
          booking.customerId,
          dto.confirmedAmount ?? null,
        );
        await this.auditLogService.logWithManager(manager, {
          actorUserId: actor.id,
          actorRole: actor.role,
          action: 'CASH_SETTLEMENT_DISPUTED',
          resourceType: 'cash_settlement',
          resourceId: savedSettlement.id,
          after: {
            status: savedSettlement.status,
            expectedAmount: invoiceAmount,
            declaredAmount,
            confirmedAmount,
          },
        });
        return { settlement: savedSettlement, mismatch: true };
      }

      const now = new Date();
      settlement.status = CashSettlementStatus.CONFIRMED;
      settlement.confirmedByCustomerId = actor.id;
      settlement.confirmedAmount = invoiceAmount;
      settlement.confirmedAt = now;
      settlement.disputeReason = null;
      settlement.disputedByCustomerId = null;
      settlement.disputedAt = null;
      const savedSettlement = await settlementRepository.save(settlement);
      await this.applyConfirmedCash(manager, { order, invoice, settlement: savedSettlement, actor, now });
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'CASH_SETTLEMENT_CONFIRMED',
        resourceType: 'cash_settlement',
        resourceId: savedSettlement.id,
        after: {
          status: savedSettlement.status,
          amount: invoiceAmount,
          invoicePaymentStatus: invoice.paymentStatus,
        },
      });
      return { settlement: savedSettlement, mismatch: false };
    });

    if (result.mismatch) {
      throw new BusinessException(
        ErrorCodes.CASH_SETTLEMENT_MISMATCH,
        'Cash amount was not confirmed; support review is required',
      );
    }
    return toCashSettlementResponse(result.settlement);
  }

  async getCashSettlement(
    orderId: string,
    actor: FinanceActor,
  ): Promise<ReturnType<typeof toCashSettlementResponse> | null> {
    const order = await this.serviceOrderRepository.findOneBy({ id: orderId });
    if (!order) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Order not found');
    }
    await this.assertOrderAccess(order, actor);
    const settlement = await this.cashSettlementRepository.findOne({
      where: { serviceOrderId: orderId },
    });
    return settlement ? toCashSettlementResponse(settlement) : null;
  }

  async getCommissionDues(
    actor: FinanceActor,
  ): Promise<{ data: CommissionDueResponseDto[]; totalDue: number }> {
    if (actor.role !== Role.TECHNICIAN) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Commission dues not found');
    }
    const dues = await this.commissionDueRepository.find({
      where: { technicianId: actor.id },
      relations: ['serviceOrder'],
      order: { createdAt: 'DESC' },
    });
    return {
      data: dues.map(toCommissionDueResponse),
      totalDue: dues
        .filter((due) => due.status === CommissionDueStatus.PENDING)
        .reduce((sum, due) => sum + Number(due.dueAmount), 0),
    };
  }

  async initiateCommissionDuePayment(
    dueId: string,
    actor: FinanceActor,
    dto: InitiatePaymentDto,
  ): Promise<PaymentResponseDto> {
    if (actor.role !== Role.TECHNICIAN) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Commission due not found');
    }
    const mode = await this.getPaymentMode();
    const payment = await this.dataSource.transaction(async (manager) => {
      const dueRepository = manager.getRepository(CommissionDue);
      const paymentRepository = manager.getRepository(Payment);
      const due = await dueRepository.findOne({
        where: { id: dueId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!due || due.technicianId !== actor.id) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Commission due record not found');
      }
      const existing = await paymentRepository.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
        lock: { mode: 'pessimistic_write' },
      });
      if (existing) {
        if (
          existing.commissionDueId !== due.id ||
          existing.purpose !== PaymentPurpose.COMMISSION_DUE ||
          existing.requestedByUserId !== actor.id
        ) {
          throw new BusinessException(
            ErrorCodes.PAYMENT_IDEMPOTENCY_CONFLICT,
            'Idempotency key is already bound to another payment',
          );
        }
        return existing;
      }
      if (due.status === CommissionDueStatus.PAID) {
        throw new BusinessException(
          ErrorCodes.CONFLICT,
          'Commission due is already paid; no new payment attempt was created',
        );
      }
      const payment = paymentRepository.create({
        invoiceId: null,
        commissionDueId: due.id,
        purpose: PaymentPurpose.COMMISSION_DUE,
        amount: this.requireWholeVnd(due.dueAmount, 'Commission due amount'),
        currency: 'VND',
        mode,
        provider: null,
        status: PaymentAttemptStatus.PENDING,
        idempotencyKey: dto.idempotencyKey,
        requestedByUserId: actor.id,
        failureCode: null,
        requestedAt: new Date(),
        verifiedAt: null,
      });
      return paymentRepository.save(payment);
    });

    const effectiveMode = payment.mode;
    if (payment.status !== PaymentAttemptStatus.PENDING) {
      return toPaymentResponse(payment);
    }
    if (effectiveMode === PaymentMode.DEMO) {
      return toPaymentResponse(payment);
    }
    const verification = await this.verifyPayment({
      amount: Number(payment.amount),
      currency: 'VND',
      mode: effectiveMode,
      purpose: PaymentPurpose.COMMISSION_DUE,
      commissionDueId: payment.commissionDueId,
    });
    const applied = await this.applyVerification(payment, verification, effectiveMode);
    if (applied.status === PaymentAttemptStatus.FAILED) {
      throw new BusinessException(
        applied.failureCode === ErrorCodes.PAYMENT_AMOUNT_MISMATCH
          ? ErrorCodes.PAYMENT_AMOUNT_MISMATCH
          : ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Payment verification failed; the commission due was not marked paid',
      );
    }
    return toPaymentResponse(applied);
  }

  async listPlatformDues(
    query: PlatformDueQueryDto,
  ): Promise<{ data: PlatformDueResponseDto[]; total: number }> {
    const [dues, total] = await this.platformDueRepository.findAndCount({
      where: query.status ? { status: query.status } : {},
      order: { createdAt: 'DESC' },
      skip: query.skip,
      take: query.limit,
    });
    return { data: dues.map(toPlatformDueResponse), total };
  }

  /**
   * Read-only eligibility hook for Dev1 server-side integration.
   * Returns true when the technician carries any active unpaid platform debt:
   * a canonical PlatformDue in PENDING status on a service order where this
   * technician holds an ACTIVE assignment (isActive=true), or a legacy
   * CommissionDue in PENDING status. Bounded single-row/EXISTS queries only;
   * historic (isActive=false) assignments never attribute debt, no unbounded
   * In(list), no cache, no mutation, no ServiceOrder status change.
   */
  async hasActiveUnpaidPlatformDue(technicianId: string): Promise<boolean> {
    if (typeof technicianId !== 'string' || technicianId.trim().length === 0) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Technician id must be provided',
      );
    }

    const legacyPending = await this.commissionDueRepository.exists({
      where: { technicianId, status: CommissionDueStatus.PENDING },
    });
    if (legacyPending) {
      return true;
    }

    const pendingPlatformDue = await this.platformDueRepository
      .createQueryBuilder('due')
      .innerJoin(
        TechnicianAssignment,
        'activeAssignment',
        'activeAssignment.serviceOrderId = due.serviceOrderId ' +
          'AND activeAssignment.technicianId = :technicianId ' +
          'AND activeAssignment.isActive = :isActive',
        { technicianId, isActive: true },
      )
      .where('due.status = :pendingStatus', {
        pendingStatus: PlatformDueStatus.PENDING,
      })
      .select('due.id')
      .limit(1)
      .getOne();
    return pendingPlatformDue !== null;
  }

  /**
   * Read-only payment hook for Dev1 server-side integration.
   * Server authoritative: the single truth source is the canonical Invoice
   * paymentStatus. A CONFIRMED cash settlement always marks the invoice PAID
   * in the same transaction, so cash follows invoice semantics here instead
   * of a second truth source. Never trusts client success, never transitions
   * ServiceOrder.status. Unknown orders and missing invoices report false.
   */
  async isOrderPaymentSatisfied(serviceOrderId: string): Promise<boolean> {
    if (typeof serviceOrderId !== 'string' || serviceOrderId.trim().length === 0) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Service order id must be provided',
      );
    }

    const order = await this.serviceOrderRepository.findOne({
      where: { id: serviceOrderId },
      select: ['id'],
    });
    if (!order) {
      return false;
    }
    const invoice = await this.invoiceRepository.findOne({
      where: { serviceOrderId },
      select: ['paymentStatus'],
    });
    if (!invoice) {
      return false;
    }
    return invoice.paymentStatus === PaymentStatus.PAID;
  }

  private async assertOrderAccess(
    order: ServiceOrder,
    actor: FinanceActor,
    manager?: EntityManager,
  ): Promise<void> {
    if (actor.role === Role.ADMIN || actor.role === Role.SERVICE_MANAGER) return;
    const bookingRepository = manager?.getRepository(Booking) ?? this.bookingRepository;
    const assignmentRepository =
      manager?.getRepository(TechnicianAssignment) ?? this.assignmentRepository;
    const booking = await bookingRepository.findOneBy({ id: order.bookingId });
    if (actor.role === Role.CUSTOMER && booking?.customerId === actor.id) return;
    if (actor.role === Role.TECHNICIAN) {
      const assignment = await assignmentRepository.findOne({
        where: { serviceOrderId: order.id, technicianId: actor.id, isActive: true },
      });
      if (assignment) return;
    }
    throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Order not found');
  }

  async getPaymentMode(): Promise<PaymentMode> {
    const raw = (await this.configService.getString('payment.mode', 'LIVE'))
      .trim()
      .toUpperCase();
    if (raw === PaymentMode.DEMO) return PaymentMode.DEMO;
    if (raw === PaymentMode.LIVE) return PaymentMode.LIVE;
    throw new BusinessException(
      ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
      'Payment mode is not configured',
    );
  }

  private async verifyPayment(
    input: Parameters<PaymentVerificationPort['verify']>[0],
  ) {
    try {
      return await this.paymentVerificationPort.verify(input);
    } catch {
      return { outcome: 'unavailable' as const, code: 'PAYMENT_PROVIDER_UNAVAILABLE' as const };
    }
  }

  private async applyVerification(
    payment: Payment,
    verification: Awaited<ReturnType<PaymentVerificationPort['verify']>>,
    mode: PaymentMode,
  ): Promise<Payment> {
    if (verification.outcome === 'unavailable') {
      if (mode === PaymentMode.DEMO) {
        return payment;
      }
      await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(Payment);
        const current = await repository.findOne({
          where: { id: payment.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (current && current.status === PaymentAttemptStatus.PENDING) {
          current.status = PaymentAttemptStatus.FAILED;
          current.failureCode = ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE;
          await repository.save(current);
        }
      });
      throw new BusinessException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Payment provider verification is unavailable; payment was not completed',
      );
    }

    if (
      verification.currency !== 'VND' ||
      !Number.isSafeInteger(verification.amount) ||
      verification.amount !== Number(payment.amount) ||
      typeof verification.providerReference !== 'string' ||
      verification.providerReference.trim().length === 0 ||
      verification.providerReference.length > 255
    ) {
      const failed = await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(Payment);
        const current = await repository.findOne({
          where: { id: payment.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!current) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Payment not found');
        current.status = PaymentAttemptStatus.FAILED;
        current.failureCode = ErrorCodes.PAYMENT_AMOUNT_MISMATCH;
        return repository.save(current);
      });
      throw new BusinessException(
        ErrorCodes.PAYMENT_AMOUNT_MISMATCH,
        'Provider verification did not match the server invoice amount',
        { paymentId: failed.id },
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const paymentRepository = manager.getRepository(Payment);
      const current = await paymentRepository.findOne({
        where: { id: payment.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Payment not found');
      if (current.status !== PaymentAttemptStatus.PENDING) return current;

      const now = new Date();
      if (current.purpose === PaymentPurpose.INVOICE && current.invoiceId) {
        const invoiceRepository = manager.getRepository(Invoice);
        const invoice = await invoiceRepository.findOne({
          where: { id: current.invoiceId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!invoice) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Invoice not found');
        if (invoice.paymentStatus === PaymentStatus.PAID) {
          current.status = PaymentAttemptStatus.CANCELLED;
          current.failureCode = 'INVOICE_ALREADY_PAID';
          return paymentRepository.save(current);
        }
        if (Number(invoice.grandTotal) !== Number(current.amount)) {
          current.status = PaymentAttemptStatus.FAILED;
          current.failureCode = ErrorCodes.PAYMENT_AMOUNT_MISMATCH;
          return paymentRepository.save(current);
        }
        await this.markInvoicePaidOnline(manager, invoice, current.requestedByUserId, now);
      } else if (current.purpose === PaymentPurpose.COMMISSION_DUE && current.commissionDueId) {
        const dueRepository = manager.getRepository(CommissionDue);
        const due = await dueRepository.findOne({
          where: { id: current.commissionDueId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!due) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Commission due record not found');
        if (due.status === CommissionDueStatus.PAID) {
          current.status = PaymentAttemptStatus.CANCELLED;
          current.failureCode = 'COMMISSION_DUE_ALREADY_PAID';
          return paymentRepository.save(current);
        }
        due.status = CommissionDueStatus.PAID;
        due.paidAt = now;
        due.paymentReference = current.id;
        await dueRepository.save(due);
      } else if (current.purpose === PaymentPurpose.WALLET_TOP_UP) {
        // Whose wallet: a customer's ledger or a technician's (PO 08/10/2026).
        const payer = await manager.findOne(User, { where: { id: current.requestedByUserId }, select: { id: true, role: true } });
        if (payer?.role === Role.CUSTOMER) {
          if (!this.customerWalletService) throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Customer wallet is unavailable');
          await this.customerWalletService.apply(manager, {
            userId: current.requestedByUserId,
            type: 'top_up',
            amount: Number(current.amount),
            idempotencyKey: `TOP_UP:${current.idempotencyKey}`,
            referenceType: 'PAYMENT',
            referenceId: current.id,
            description: 'Nạp ví qua VNPay',
          });
        } else if (this.walletService) {
          await this.walletService.topUp(
            current.requestedByUserId,
            Number(current.amount),
            current.idempotencyKey,
            manager,
          );
        }
      }

      current.status = PaymentAttemptStatus.VERIFIED;
      current.providerReference = verification.providerReference.trim();
      current.verifiedAt = now;
      current.failureCode = null;
      const saved = await paymentRepository.save(current);
      await this.auditLogService.logWithManager(manager, {
        actorUserId: current.requestedByUserId,
        actorRole:
          current.purpose === PaymentPurpose.COMMISSION_DUE
            ? Role.TECHNICIAN
            : current.purpose === PaymentPurpose.WALLET_TOP_UP
              ? ((await manager.findOne(User, { where: { id: current.requestedByUserId }, select: { id: true, role: true } }))?.role ?? Role.TECHNICIAN)
              : Role.CUSTOMER,
        action: 'PAYMENT_VERIFIED',
        resourceType: 'payment',
        resourceId: current.id,
        after: { purpose: current.purpose, amount: Number(current.amount) },
      });
      return saved;
    });
  }

  /**
   * What follows an invoice being paid to FixHome (VNPay or the customer
   * wallet): invoice and order paid, the commission collected at once, the
   * order completed when the work is confirmed, and the technician's share
   * settled into their wallet. The caller holds the invoice row lock.
   */
  private async markInvoicePaidOnline(manager: EntityManager, invoice: Invoice, payerUserId: string, now: Date): Promise<void> {
    if (this.requireWholeVnd(invoice.grandTotal, 'Invoice amount') <= 0) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Hóa đơn 0 ₫ cần được xác nhận miễn phí.');
    }
    const invoiceRepository = manager.getRepository(Invoice);
    const orderRepository = manager.getRepository(ServiceOrder);
    invoice.paymentStatus = PaymentStatus.PAID;
    invoice.paidAt = now;
    await invoiceRepository.save(invoice);
    await orderRepository.update(
      { id: invoice.serviceOrderId },
      { paymentStatus: PaymentStatus.PAID },
    );
    const order = await manager.findOne(ServiceOrder, {
      where: { id: invoice.serviceOrderId },
    });
    if (!order) return;
    await this.ensureFinancialDues(manager, invoice, order, null, now);
    // No customer acceptance step (PO 09/10/2026): paid after the technician reported completion is done.
    if (
      order.completionRequestedAt &&
      order.status === ServiceOrderStatus.UNDER_REPAIR &&
      !(await isCompletionHeld(manager, order.id))
    ) {
      if (ServiceOrderStateMachine.canTransition(order.status, ServiceOrderStatus.COMPLETED)) {
        order.status = ServiceOrderStatus.COMPLETED;
        order.completedAt = now;
        await orderRepository.save(order);
        await manager.insert(OrderStatusHistory, {
          serviceOrderId: order.id,
          fromStatus: ServiceOrderStatus.UNDER_REPAIR,
          toStatus: ServiceOrderStatus.COMPLETED,
          actorUserId: payerUserId,
          actorRole: Role.CUSTOMER,
          reason: 'Work completed by the technician and payment verified',
        });
        await applyOrderCompletionEffects(manager, order, invoice.id, now);
      }
    }
    if (this.settlementService && order.status === ServiceOrderStatus.COMPLETED) {
      await this.settlementService.trySettleOrder(order.id, manager);
    }
  }

  /** Read-only reconciliation of a zero snapshot. Never repairs or replaces a persisted invoice. */
  private async assertNoChargeIntegrity(manager: EntityManager, invoice: Invoice, order: ServiceOrder, booking: Booking): Promise<void> {
    const fail = () => { throw new BusinessException(ErrorCodes.CONFLICT, 'Hóa đơn chưa khớp chi phí đã duyệt. Vui lòng liên hệ FixHome để kiểm tra.'); };
    for (const value of [invoice.grandTotal, invoice.laborTotal, invoice.partsTotal, invoice.fixHomePartsTotal,
      invoice.technicianPartsTotal, invoice.technicianPartWarrantyFeeTotal, invoice.shippingFee, invoice.commissionAmount]) {
      if (value == null || this.requireWholeVnd(value, 'Invoice snapshot') !== 0) fail();
    }
    const persistedItems = await manager.find(InvoiceItem, { where: { invoiceId: invoice.id } });
    for (const item of persistedItems) {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || this.requireWholeVnd(item.unitPrice, 'Invoice item price') !== 0 ||
          this.requireWholeVnd(item.lineTotal, 'Invoice item total') !== 0 || this.requireWholeVnd(item.warrantyFee ?? 0, 'Invoice warranty') !== 0) fail();
    }
    const quotation = await manager.findOne(Quotation, { where: { serviceOrderId: order.id, status: QuotationStatus.APPROVED }, relations: ['items'] });
    if (booking.pricingModeSnapshot === ServicePricingMode.FIXED_PRICE) {
      if (booking.fixedUnitPriceSnapshot == null || this.requireWholeVnd(booking.fixedUnitPriceSnapshot, 'Fixed price') !== 0) fail();
    } else if (booking.pricingModeSnapshot !== ServicePricingMode.INSPECTION_REQUIRED || !quotation) fail();
    const costs = await manager.find(AdditionalCostRequest, { where: { serviceOrderId: order.id, status: AdditionalCostStatus.APPROVED }, relations: ['items'] });
    const requests = await holderPartRequests(manager, order.id);
    assertPartsResolved(requests);
    const custodyUsage = await custodyUsageForInvoice(manager, order.id);
    const lines = [
      ...(quotation?.items ?? []).map(item => ({ ...item, source: 'quotation' })),
      ...costs.flatMap(cost => cost.items.map(item => ({ ...item, source: cost.id }))),
    ];
    assertApprovedPartsResolved(lines, requests, quotation?.id ?? null, custodyUsage);
    const billable = usedPartQuantities(requests, custodyUsage, quotation?.id ?? null, lines);
    for (const line of lines) {
      if (!Object.values(CostItemType).includes(line.type) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 ||
          (line.type === CostItemType.PARTS_EQUIPMENT && !Object.values(PartSource).includes(line.partSource!))) fail();
      const price = this.requireWholeVnd(line.unitPrice, 'Approved price');
      const total = price * line.quantity;
      if (!Number.isSafeInteger(total) || this.requireWholeVnd(line.lineTotal, 'Approved total') !== total) fail();
      if (billable(line.source, line) * price > 0 || this.requireWholeVnd(line.warrantyFee ?? 0, 'Approved warranty') > 0) fail();
    }
    if (quotation) {
      const labor = quotation.items.filter(i => i.type === CostItemType.LABOR).reduce((sum, i) => sum + i.quantity * Number(i.unitPrice), 0);
      const parts = quotation.items.filter(i => i.type === CostItemType.PARTS_EQUIPMENT).reduce((sum, i) => sum + i.quantity * Number(i.unitPrice), 0);
      if (Number(quotation.laborTotal) !== labor || Number(quotation.partsTotal) !== parts) fail();
    }
    for (const cost of costs) {
      const labor = cost.items.filter(i => i.type === CostItemType.LABOR).reduce((sum, i) => sum + i.quantity * Number(i.unitPrice), 0);
      const parts = cost.items.filter(i => i.type === CostItemType.PARTS_EQUIPMENT).reduce((sum, i) => sum + i.quantity * Number(i.unitPrice), 0);
      if (Number(cost.totalLaborDelta) !== labor || Number(cost.totalPartsDelta) !== parts) fail();
      if (this.requireWholeVnd(cost.shippingFee ?? 0, 'Approved shipping') > 0) fail();
    }
    if (await manager.count(Quotation, { where: { serviceOrderId: order.id, status: QuotationStatus.SENT } }) ||
        await manager.count(AdditionalCostRequest, { where: { serviceOrderId: order.id, status: AdditionalCostStatus.PENDING_APPROVAL } })) fail();
  }

  /** Customer-authorized zero confirmation: no provider success, Payment row or wallet/settlement entry. */
  async confirmNoChargeInvoice(invoiceId: string, actor: FinanceActor): Promise<NoChargeInvoiceResponseDto> {
    if (actor.role !== Role.CUSTOMER) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Chỉ khách hàng được xác nhận hóa đơn.');
    return this.dataSource.transaction(async manager => {
      const reference = await manager.findOne(Invoice, { where: { id: invoiceId } });
      if (!reference) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Không tìm thấy hóa đơn.');
      let order = await manager.findOne(ServiceOrder, { where: { id: reference.serviceOrderId } });
      if (!order) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Không tìm thấy đơn sửa chữa.');
      const booking = await manager.findOne(Booking, { where: { id: order.bookingId } });
      if (!booking || booking.customerId !== actor.id) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Bạn không có quyền xác nhận hóa đơn này.');
      // Positive payments use the existing finance lock paths. Reject them before
      // acquiring an Order lock; the locked zero snapshot is rechecked below.
      if (this.requireWholeVnd(reference.grandTotal, 'Invoice amount') !== 0) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Hóa đơn còn số tiền cần thanh toán.');
      }
      // Match parts/completion lock order, then serialize zero confirmation and replay.
      order = await manager.findOneOrFail(ServiceOrder, { where: { id: order.id }, lock: { mode: 'pessimistic_write' } });
      const invoice = await manager.findOneOrFail(Invoice, { where: { id: invoiceId, serviceOrderId: order.id }, lock: { mode: 'pessimistic_write' } });
      const response = (): NoChargeInvoiceResponseDto => ({ invoiceId, paymentStatus: 'paid', settlementMethod: 'NO_CHARGE' });
      if (invoice.paymentStatus === PaymentStatus.PAID) {
        const confirmed = await manager.findOne(AuditLog, { where: { resourceType: 'invoice', resourceId: invoice.id, action: 'INVOICE_NO_CHARGE_CONFIRMED', actorUserId: actor.id } });
        if (confirmed && Number(invoice.grandTotal) === 0) return response();
        throw new BusinessException(ErrorCodes.CONFLICT, 'Hóa đơn đã được thanh toán.');
      }
      if (invoice.paymentStatus !== PaymentStatus.UNPAID || order.status !== ServiceOrderStatus.UNDER_REPAIR || !order.completionRequestedAt) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Đơn sửa chữa chưa sẵn sàng để xác nhận miễn phí.');
      }
      await this.assertNoChargeIntegrity(manager, invoice, order, booking);
      const required = await this.configService.getInt('evidence.after.min_count', 1);
      if (await manager.count(RepairEvidence, { where: { serviceOrderId: order.id, type: EvidenceType.AFTER } }) < required) {
        throw new BusinessException(ErrorCodes.EVIDENCE_REQUIRED_AFTER, 'Cần ảnh sau sửa chữa trước khi hoàn tất đơn.');
      }
      const now = new Date();
      invoice.paymentStatus = PaymentStatus.PAID;
      invoice.paidAt = now;
      await manager.save(Invoice, invoice);
      order.paymentStatus = PaymentStatus.PAID;
      if (!await isCompletionHeld(manager, order.id)) {
        if (!ServiceOrderStateMachine.canTransition(order.status, ServiceOrderStatus.COMPLETED)) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Không thể hoàn tất đơn sửa chữa.');
        order.status = ServiceOrderStatus.COMPLETED;
        order.completedAt = now;
        await manager.insert(OrderStatusHistory, { serviceOrderId: order.id, fromStatus: ServiceOrderStatus.UNDER_REPAIR, toStatus: order.status,
          actorUserId: actor.id, actorRole: actor.role, reason: 'Customer confirmed NO_CHARGE invoice' });
        await closeOrderPartRequests(manager, order.id, false);
        await applyOrderCompletionEffects(manager, order, invoice.id, now);
      }
      await manager.save(ServiceOrder, order);
      await manager.update(Payment, { invoiceId: invoice.id, status: PaymentAttemptStatus.PENDING }, { status: PaymentAttemptStatus.CANCELLED, failureCode: 'NO_CHARGE_CONFIRMED' });
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'INVOICE_NO_CHARGE_CONFIRMED',
        resourceType: 'invoice', resourceId: invoice.id, after: { serviceOrderId: order.id, amount: 0, method: 'NO_CHARGE', orderStatus: order.status } });
      return response();
    });
  }

  /**
   * The customer pays the whole invoice from their wallet (PO 08/10/2026).
   * One transaction: the invoice lock, the wallet debit and the payment record
   * succeed together or not at all; the rest is the same as a VNPay payment.
   */
  /** F5: a fully funded invoice closes from the verified server snapshot with no fake provider attempt. */
  async closeVoucherZeroDue(scopeKind: VoucherFundingScopeKind, scopeOrInvoiceId: string,
    actor: FinanceActor, reservationId: string): Promise<{ paid: true; amount: 0; settlementId: string }> {
    if (actor.role !== Role.CUSTOMER) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the customer can close this payment');
    }
    if (!this.vouchersService) {
      throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Thanh toán ưu đãi chưa sẵn sàng.');
    }
    return this.dataSource.transaction(async manager => {
      const reference = scopeKind === 'SOLO'
        ? await manager.findOneBy(Invoice, { id: scopeOrInvoiceId }) : null;
      if (scopeKind === 'SOLO' && !reference) {
        throw new BusinessException(ErrorCodes.NOT_FOUND, 'Invoice not found');
      }
      const scopeId = reference?.serviceOrderId ?? scopeOrInvoiceId;
      const quote = await this.quoteVoucherRail(manager, { reservationId,
        customerId: actor.id, scopeId, scopeKind, rail: 'ZERO', invoiceId: reference?.id });
      if (scopeKind === 'SOLO') {
        const invoice = await manager.findOne(Invoice, { where: { id: reference!.id }, lock: { mode: 'pessimistic_write' } });
        const order = invoice && await manager.findOneBy(ServiceOrder, { id: invoice.serviceOrderId });
        const booking = order && await manager.findOneBy(Booking, { id: order.bookingId });
        if (!invoice || !order || !booking || booking.customerId !== actor.id || booking.visitGroupId ||
            invoice.paymentStatus === PaymentStatus.PAID ||
            Number(invoice.grandTotal) !== quote.total.originalGrossVnd ||
            order.status === ServiceOrderStatus.CANCELLED) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Hóa đơn đã thay đổi.');
        }
      } else {
        await this.visitAccess(manager, scopeId, actor, true);
        allocateFundedVisitCharge(await this.readyVisitCharge(manager, scopeId), quote);
      }
      await this.assertNoStoppedCollection(manager, scopeId, scopeKind);
      await this.assertNoActiveCashIntent(manager, scopeKind, scopeId);
      const link = await bindVoucherPaymentLink(manager, reservationId, 'ZERO');
      if (link.customerId !== actor.id || link.scopeId !== scopeId ||
          link.scopeKind !== scopeKind || link.customerDueVnd !== 0) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Voucher closeout changed.');
      }
      const now = new Date((await manager.query('SELECT clock_timestamp() AS now'))[0]?.now);
      if (!Number.isFinite(+now) || +now < +link.createdAt) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Voucher closeout time is invalid.');
      }
      for (const allocation of quote.invoices) {
        const invoice = await manager.findOneOrFail(Invoice, { where: { id: allocation.invoiceId } });
        if (Number(invoice.grandTotal) !== allocation.originalGrossVnd ||
            invoice.paymentStatus === PaymentStatus.PAID) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Hóa đơn đã thay đổi.');
        }
        await this.markInvoicePaidOnline(manager, invoice, actor.id, now);
      }
      await commitVerifiedVoucherFunding(manager, link.id);
      await this.vouchersService!.redeemSettled(link.id, manager);
      return { paid: true as const, amount: 0 as const, settlementId: link.id };
    });
  }

  private async payVoucherInvoiceWithWallet(invoiceId: string, actor: FinanceActor, reservationId: string): Promise<{ invoiceId: string; paid: true; amount: number; balance: number }> {
    if (!this.customerWalletService || !this.vouchersService) {
      throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Thanh toán ưu đãi chưa sẵn sàng.');
    }
    return this.dataSource.transaction(async manager => {
      const reference = await manager.findOneBy(Invoice, { id: invoiceId });
      if (!reference) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Invoice not found');
      const quote = await this.quoteVoucherRail(manager, { reservationId, customerId: actor.id,
        scopeId: reference.serviceOrderId, scopeKind: 'SOLO', rail: 'WALLET', invoiceId });
      const invoice = await manager.findOne(Invoice, { where: { id: invoiceId }, lock: { mode: 'pessimistic_write' } });
      if (!invoice || invoice.serviceOrderId !== reference.serviceOrderId ||
          invoice.paymentStatus === PaymentStatus.PAID || Number(invoice.grandTotal) !== quote.total.originalGrossVnd) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Hóa đơn đã thay đổi.');
      }
      const order = await manager.findOneBy(ServiceOrder, { id: invoice.serviceOrderId });
      const booking = order && await manager.findOneBy(Booking, { id: order.bookingId });
      if (!order || !booking || booking.customerId !== actor.id || booking.visitGroupId ||
          order.status === ServiceOrderStatus.CANCELLED) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Invoice not found');
      }
      await this.assertNoStoppedCollection(manager, order.id);
      await this.assertNoActiveCashIntent(manager, 'SOLO', order.id);
      const amount = quote.total.customerDueVnd;
      const now = new Date();
      const debit = await this.customerWalletService!.apply(manager, { userId: actor.id,
        type: 'invoice_payment', amount, idempotencyKey: `VOUCHER_INVOICE:${reservationId}`,
        referenceType: 'INVOICE', referenceId: invoice.id,
        description: `Thanh toán đơn #${order.code}` });
      const payment = await manager.save(Payment, manager.create(Payment, {
        invoiceId, commissionDueId: null, purpose: PaymentPurpose.INVOICE, amount,
        currency: 'VND', mode: PaymentMode.LIVE, provider: 'wallet',
        status: PaymentAttemptStatus.VERIFIED, idempotencyKey: `VOUCHER_WALLET:${reservationId}`,
        providerReference: `WALLET_TX:${debit.id}`, requestedByUserId: actor.id,
        failureCode: null, requestedAt: now, verifiedAt: now,
      }));
      await this.bindVoucherPaymentAfterRecord(manager, { reservationId, rail: 'WALLET', sourceId: payment.id,
        customerId: actor.id, scopeId: order.id, scopeKind: 'SOLO' });
      await manager.update(Payment, { invoiceId, status: PaymentAttemptStatus.PENDING },
        { status: PaymentAttemptStatus.CANCELLED, failureCode: 'PAID_FROM_WALLET' });
      await this.markInvoicePaidOnline(manager, invoice, actor.id, now);
      await commitVerifiedVoucherFunding(manager, payment.id);
      await this.vouchersService!.redeemSettled(payment.id, manager);
      return { invoiceId, paid: true as const, amount, balance: debit.balanceAfter };
    });
  }

  private async payVoucherVisitWithWallet(groupId: string, actor: FinanceActor, reservationId: string): Promise<{ visitGroupId: string; paid: true; amount: number; balance: number }> {
    if (!this.customerWalletService || !this.vouchersService) {
      throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Thanh toán ưu đãi chưa sẵn sàng.');
    }
    return this.dataSource.transaction(async manager => {
      const quote = await this.quoteVoucherRail(manager, { reservationId, customerId: actor.id,
        scopeId: groupId, scopeKind: 'VISIT_GROUP', rail: 'WALLET' });
      await this.visitAccess(manager, groupId, actor, true);
      const charge = await this.readyVisitCharge(manager, groupId);
      const funded = allocateFundedVisitCharge(charge, quote);
      await this.assertNoStoppedCollection(manager, groupId, 'VISIT_GROUP');
      await this.assertNoActiveCashIntent(manager, 'VISIT_GROUP', groupId);
      const amount = funded.customerDue;
      const now = new Date();
      const debit = await this.customerWalletService!.apply(manager, { userId: actor.id,
        type: 'invoice_payment', amount, idempotencyKey: `VOUCHER_VISIT:${reservationId}`,
        referenceType: 'VISIT_GROUP', referenceId: groupId,
        description: `Thanh toán lượt sửa ${funded.allocations.length} thiết bị` });
      const payment = await manager.save(VisitGroupPayment, manager.create(VisitGroupPayment, {
        visitGroupId: groupId, rail: 'wallet', status: 'verified', amount,
        allocations: funded.allocations, idempotencyKey: `VOUCHER_WALLET:${reservationId}`,
        providerReference: `WALLET_TX:${debit.id}`, requestedByUserId: actor.id,
        requestedAt: now, verifiedAt: now,
      }));
      await this.bindVoucherPaymentAfterRecord(manager, { reservationId, rail: 'WALLET', sourceId: payment.id,
        customerId: actor.id, scopeId: groupId, scopeKind: 'VISIT_GROUP' });
      await this.cancelOpenVisitPayments(manager, groupId, 'PAID_FROM_WALLET', payment.id);
      for (const allocation of funded.allocations) {
        const invoice = await manager.findOneOrFail(Invoice, { where: { id: allocation.invoiceId } });
        await manager.update(Payment, { invoiceId: invoice.id, status: PaymentAttemptStatus.PENDING },
          { status: PaymentAttemptStatus.CANCELLED, failureCode: 'PAID_FROM_WALLET' });
        await manager.save(Payment, manager.create(Payment, {
          invoiceId: invoice.id, commissionDueId: null, purpose: PaymentPurpose.INVOICE,
          amount: allocation.amount, currency: 'VND', mode: PaymentMode.LIVE,
          provider: 'wallet', status: PaymentAttemptStatus.VERIFIED,
          idempotencyKey: `VOUCHER_WALLET_VISIT:${reservationId}:${invoice.id}`,
          providerReference: `WALLET_TX:${debit.id}:${invoice.id}`,
          requestedByUserId: actor.id, failureCode: null, requestedAt: now, verifiedAt: now,
        }));
        await this.markInvoicePaidOnline(manager, invoice, actor.id, now);
      }
      await commitVerifiedVoucherFunding(manager, payment.id);
      await this.vouchersService!.redeemSettled(payment.id, manager);
      return { visitGroupId: groupId, paid: true as const, amount, balance: debit.balanceAfter };
    });
  }

  async payInvoiceWithWallet(invoiceId: string, actor: FinanceActor, voucherReservationId?: string): Promise<{ invoiceId: string; paid: true; amount: number; balance: number }> {
    if (actor.role !== Role.CUSTOMER) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the invoice customer can pay it');
    }

    if (voucherReservationId !== undefined) return this.payVoucherInvoiceWithWallet(invoiceId, actor, voucherReservationId);
    if (!this.customerWalletService) {
      throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Ví chưa sẵn sàng, vui lòng thử lại sau');
    }
    const wallet = this.customerWalletService;
    return this.dataSource.transaction(async (manager) => {
      const invoice = await manager.findOne(Invoice, { where: { id: invoiceId }, lock: { mode: 'pessimistic_write' } });
      if (!invoice) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Invoice not found');
      const order = await manager.findOne(ServiceOrder, { where: { id: invoice.serviceOrderId } });
      if (!order) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Service order not found');
      const booking = await manager.findOne(Booking, { where: { id: order.bookingId } });
      if (!booking || booking.customerId !== actor.id) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Invoice not found');
      }
      this.refuseVisitInvoice(booking);
      if (invoice.paymentStatus === PaymentStatus.PAID) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Hoá đơn đã được thanh toán');
      }
      if (order.status === ServiceOrderStatus.CANCELLED) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Đơn đã huỷ, không thanh toán hoá đơn này được');
      }
      const amount = this.requireWholeVnd(invoice.grandTotal, 'Invoice amount');
      if (amount <= 0) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Hoá đơn không có số tiền cần thanh toán');
      await this.assertNoActiveCashIntent(manager, 'SOLO', order.id);
      await this.assertNewCollectionAllowed(manager, order.id);
      const now = new Date();
      const tx = await wallet.apply(manager, {
        userId: actor.id,
        type: 'invoice_payment',
        amount,
        idempotencyKey: `INVOICE:${invoice.id}`,
        referenceType: 'INVOICE',
        referenceId: invoice.id,
        description: `Thanh toán đơn #${order.code}`,
      });
      // A VNPay attempt still open for this invoice can no longer be applied.
      await manager.update(Payment, { invoiceId: invoice.id, status: PaymentAttemptStatus.PENDING }, { status: PaymentAttemptStatus.CANCELLED, failureCode: 'PAID_FROM_WALLET' });
      const payment = await manager.save(Payment, manager.create(Payment, {
        invoiceId: invoice.id,
        commissionDueId: null,
        purpose: PaymentPurpose.INVOICE,
        amount,
        currency: 'VND',
        mode: PaymentMode.LIVE,
        provider: 'wallet',
        status: PaymentAttemptStatus.VERIFIED,
        idempotencyKey: `WALLET_INVOICE:${invoice.id}`,
        providerReference: `WALLET_TX:${tx.id}`,
        requestedByUserId: actor.id,
        failureCode: null,
        requestedAt: now,
        verifiedAt: now,
      }));
      await this.markInvoicePaidOnline(manager, invoice, actor.id, now);
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id,
        actorRole: Role.CUSTOMER,
        action: 'PAYMENT_VERIFIED',
        resourceType: 'payment',
        resourceId: payment.id,
        after: { purpose: PaymentPurpose.INVOICE, provider: 'wallet', amount },
      });
      return { invoiceId: invoice.id, paid: true as const, amount, balance: tx.balanceAfter };
    });
  }

  /**
   * Everything that follows a cash settlement becoming CONFIRMED, whether the
   * customer confirmed it or a Service Manager resolved the dispute: invoice
   * paid, order completed when the work is confirmed, the cash payment record,
   * the dues and the wallet settlement. One path, so the two cannot drift.
   */
  async applyConfirmedCash(
    manager: EntityManager,
    params: { order: ServiceOrder; invoice: Invoice; settlement: CashSettlement; actor: FinanceActor; now: Date; collectedAmount?: number },
  ): Promise<void> {
    if (this.requireWholeVnd(params.invoice.grandTotal, 'Invoice amount') <= 0) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Hóa đơn 0 ₫ cần được khách hàng xác nhận miễn phí.');
    }
    const { order, invoice, settlement: savedSettlement, actor, now } = params;
    const orderRepository = manager.getRepository(ServiceOrder);
    const invoiceRepository = manager.getRepository(Invoice);
      invoice.paymentStatus = PaymentStatus.PAID;
      invoice.paidAt = now;
      await invoiceRepository.save(invoice);
      await orderRepository.update(
        { id: order.id },
        { paymentStatus: PaymentStatus.PAID },
      );
      order.paymentStatus = PaymentStatus.PAID;

      // No customer acceptance step (PO 09/10/2026): paid after the technician reported completion is done.
      if (
        order.completionRequestedAt &&
        order.status === ServiceOrderStatus.UNDER_REPAIR &&
        !(await isCompletionHeld(manager, order.id))
      ) {
        if (!ServiceOrderStateMachine.canTransition(order.status, ServiceOrderStatus.COMPLETED)) {
          throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Illegal order transition');
        }
        order.status = ServiceOrderStatus.COMPLETED;
        order.completedAt = now;
        await orderRepository.save(order);
        await manager.insert(OrderStatusHistory, {
          serviceOrderId: order.id,
          fromStatus: ServiceOrderStatus.UNDER_REPAIR,
          toStatus: ServiceOrderStatus.COMPLETED,
          actorUserId: actor.id,
          actorRole: actor.role,
          reason: 'Work completed by the technician and payment verified',
        });
        await applyOrderCompletionEffects(manager, order, invoice.id, now);
      }

      await this.ensureCashPayment(manager, invoice, savedSettlement, actor.id, now, params.collectedAmount);
      await this.ensureFinancialDues(manager, invoice, order, savedSettlement, now);
      if (this.settlementService) {
        await this.settlementService.trySettleOrder(order.id, manager);
      }
  }

  private async ensureCashPayment(
    manager: EntityManager,
    invoice: Invoice,
    settlement: CashSettlement,
    actorUserId: string,
    now: Date,
    collectedAmount?: number,
  ): Promise<void> {
    const repository = manager.getRepository(Payment);
    const existing = await repository.findOne({
      where: { invoiceId: invoice.id, purpose: PaymentPurpose.INVOICE },
    });
    if (existing?.status === PaymentAttemptStatus.VERIFIED) return;
    if (existing && existing.status === PaymentAttemptStatus.PENDING) {
      existing.status = PaymentAttemptStatus.CANCELLED;
      existing.failureCode = 'CASH_SETTLEMENT_CONFIRMED';
      await repository.save(existing);
    }
    await repository.save(
      repository.create({
        invoiceId: invoice.id,
        commissionDueId: null,
        purpose: PaymentPurpose.INVOICE,
        amount: this.requireWholeVnd(collectedAmount ?? invoice.grandTotal, 'Collected amount'),
        currency: 'VND',
        mode: PaymentMode.DEMO,
        provider: null,
        status: PaymentAttemptStatus.VERIFIED,
        idempotencyKey: `cash-settlement:${settlement.id}`,
        providerReference: null,
        requestedByUserId: actorUserId,
        failureCode: null,
        requestedAt: settlement.declaredAt ?? now,
        verifiedAt: now,
      }),
    );
  }

  private async ensureFinancialDues(
    manager: EntityManager,
    invoice: Invoice,
    order: ServiceOrder,
    settlement: CashSettlement | null,
    now: Date,
  ): Promise<void> {
    const commissionDueRepository = manager.getRepository(CommissionDue);
    const platformDueRepository = manager.getRepository(PlatformDue);
    const laborTotal = this.requireWholeVnd(invoice.laborTotal, 'Labor total');
    const partsTotal = this.requireWholeVnd(invoice.partsTotal, 'Parts total');
    const fixHomePartsTotal = this.requireWholeVnd(invoice.fixHomePartsTotal, 'FixHome parts total');
    const technicianPartsTotal = this.requireWholeVnd(invoice.technicianPartsTotal, 'Technician parts total');
    const warrantyFeeTotal = this.requireWholeVnd(invoice.technicianPartWarrantyFeeTotal, 'Warranty fee total');
    const shippingFee = this.requireWholeVnd(invoice.shippingFee ?? 0, 'Shipping fee');
    const grandTotal = this.requireWholeVnd(invoice.grandTotal, 'Invoice amount');
    const commissionAmount = this.requireWholeVnd(
      invoice.commissionAmount,
      'Commission amount',
    );
    if (partsTotal !== fixHomePartsTotal + technicianPartsTotal || grandTotal !== laborTotal + partsTotal + warrantyFeeTotal + shippingFee) {
      throw new BusinessException(
        ErrorCodes.CONFLICT,
        'Invoice total snapshot is inconsistent',
      );
    }
    // The rate frozen on the invoice is the snapshot (BRX-026). Comparing
    // with a constant broke every payment once an admin changed the rate.
    const commissionRate = Number(invoice.commissionRateSnapshot);
    if (!Number.isFinite(commissionRate) || commissionAmount !== Math.round(laborTotal * commissionRate)) {
      throw new BusinessException(
        ErrorCodes.CONFLICT,
        'Invoice commission snapshot is inconsistent',
      );
    }
    // #22: online, FixHome already holds the customer's money, so the
    // commission is collected at payment and nothing is owed afterwards.
    // PlatformDue exists only for cash (spec 8.18, BRX-030).
    const paidOnline = settlement === null;
    const assignment = await manager.findOne(TechnicianAssignment, {
      where: { serviceOrderId: order.id, isActive: true },
    });
    const technicianId = assignment?.technicianId ?? settlement?.declaredByTechnicianId;

    if (technicianId && commissionAmount > 0) {
      const existing = await commissionDueRepository.findOne({
        where: { serviceOrderId: order.id },
      });
      if (existing) {
        if (
          Number(existing.laborTotalSnapshot) !== laborTotal ||
          Number(existing.dueAmount) !== commissionAmount
        ) {
          throw new BusinessException(
            ErrorCodes.CONFLICT,
            'Historical commission snapshot cannot be changed',
          );
        }
      } else {
        const dueDate = new Date(now);
        dueDate.setDate(dueDate.getDate() + 7);
        await commissionDueRepository.save(
          commissionDueRepository.create({
            technicianId,
            serviceOrderId: order.id,
            cashSettlementId: settlement?.id ?? null,
            laborTotalSnapshot: laborTotal,
            commissionRateSnapshot: commissionRate,
            dueAmount: commissionAmount,
            status: paidOnline ? CommissionDueStatus.PAID : CommissionDueStatus.PENDING,
            paidAt: paidOnline ? now : null,
            ...(paidOnline ? { paymentReference: `ONLINE_INVOICE:${invoice.id}` } : {}),
            dueDate,
          }),
        );
      }
    }

    if (paidOnline) return;
    const existingPlatformDue = await platformDueRepository.findOne({
      where: { serviceOrderId: order.id },
    });
    const platformAmount = commissionAmount + fixHomePartsTotal + shippingFee;
    if (existingPlatformDue) {
      if (
        Number(existingPlatformDue.dueAmount) !== platformAmount ||
        Number(existingPlatformDue.fixHomePartsTotalSnapshot) !== fixHomePartsTotal
      ) {
        throw new BusinessException(
          ErrorCodes.CONFLICT,
          'Historical platform due snapshot cannot be changed',
        );
      }
      return;
    }
    await platformDueRepository.save(
      platformDueRepository.create({
        invoiceId: invoice.id,
        serviceOrderId: order.id,
        laborTotalSnapshot: laborTotal,
        fixHomePartsTotalSnapshot: fixHomePartsTotal,
        commissionRateSnapshot: commissionRate,
        commissionAmountSnapshot: commissionAmount,
        dueAmount: platformAmount,
        status: PlatformDueStatus.PENDING,
        settledAt: null,
      }),
    );
  }

  // ── One payment for a visit of several devices (PO 21/10/2026, G0-4 4B) ──

  /**
   * What the visit owes, for the customer or the technician holding it: each
   * device's state and amount, the total of the devices repaired, and whether
   * every device has its result yet (the visit is paid once, after that).
   */
  async visitCheckout(groupId: string, actor: FinanceActor) {
    await this.visitAccess(this.dataSource.manager, groupId, actor);
    const charge = await loadVisitCharge(this.dataSource.manager, groupId);
    const pendingCash = await this.dataSource.getRepository(VisitGroupPayment).findOne({
      where: { visitGroupId: groupId, rail: 'cash', status: 'pending_confirmation' },
      order: { createdAt: 'DESC' },
    });
    return {
      visitGroupId: groupId,
      devices: charge.devices,
      total: charge.total,
      waiting: charge.waiting,
      ready: charge.ready,
      paid: charge.paid,
      pendingCash: pendingCash ? { id: pendingCash.id, amount: Number(pendingCash.amount), declaredAt: pendingCash.requestedAt } : null,
    };
  }

  /** One wallet debit for the whole visit, split over the repaired devices' invoices. */
  async payVisitWithWallet(groupId: string, actor: FinanceActor, voucherReservationId?: string): Promise<{ visitGroupId: string; paid: true; amount: number; balance: number }> {
    if (actor.role !== Role.CUSTOMER) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the visit customer can pay it');
    if (voucherReservationId !== undefined) return this.payVoucherVisitWithWallet(groupId, actor, voucherReservationId);
    if (!this.customerWalletService) throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Ví chưa sẵn sàng, vui lòng thử lại sau');
    const wallet = this.customerWalletService;
    return this.dataSource.transaction(async (manager) => {
      await this.visitAccess(manager, groupId, actor, true);
      const charge = await this.readyVisitCharge(manager, groupId);
      await this.assertNoActiveCashIntent(manager, 'VISIT_GROUP', groupId);
      await this.assertNewCollectionAllowed(manager, groupId, 'VISIT_GROUP');
      const now = new Date();
      const tx = await wallet.apply(manager, {
        userId: actor.id,
        type: 'invoice_payment',
        amount: charge.total,
        idempotencyKey: `VISIT:${groupId}`,
        referenceType: 'VISIT_GROUP',
        referenceId: groupId,
        description: `Thanh toán lượt sửa ${charge.allocations.length} thiết bị`,
      });
      await this.cancelOpenVisitPayments(manager, groupId, 'PAID_FROM_WALLET');
      for (const allocation of charge.allocations) {
        const invoice = await manager.findOneOrFail(Invoice, { where: { id: allocation.invoiceId } });
        await manager.update(Payment, { invoiceId: invoice.id, status: PaymentAttemptStatus.PENDING }, { status: PaymentAttemptStatus.CANCELLED, failureCode: 'PAID_FROM_WALLET' });
        await manager.save(Payment, manager.create(Payment, {
          invoiceId: invoice.id, commissionDueId: null, purpose: PaymentPurpose.INVOICE, amount: allocation.amount, currency: 'VND',
          mode: PaymentMode.LIVE, provider: 'wallet', status: PaymentAttemptStatus.VERIFIED, idempotencyKey: `WALLET_VISIT:${invoice.id}`,
          providerReference: `WALLET_TX:${tx.id}:${invoice.id}`, requestedByUserId: actor.id, failureCode: null, requestedAt: now, verifiedAt: now,
        }));
        await this.markInvoicePaidOnline(manager, invoice, actor.id, now);
      }
      const payment = await manager.save(VisitGroupPayment, manager.create(VisitGroupPayment, {
        visitGroupId: groupId, rail: 'wallet', status: 'verified', amount: charge.total, allocations: charge.allocations,
        idempotencyKey: `WALLET:${groupId}`, providerReference: `WALLET_TX:${tx.id}`, requestedByUserId: actor.id, requestedAt: now, verifiedAt: now,
      }));
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: Role.CUSTOMER, action: 'VISIT_PAYMENT_VERIFIED', resourceType: 'visit_group_payment', resourceId: payment.id, after: { rail: 'wallet', amount: charge.total, invoices: charge.allocations.length } });
      return { visitGroupId: groupId, paid: true as const, amount: charge.total, balance: tx.balanceAfter };
    });
  }

  /** One VNPay transaction for the whole visit; the IPN splits it over the invoices frozen here. */
  async createVisitVnpayUrl(groupId: string, actor: FinanceActor, ipAddr: string, platform: 'web' | 'mobile' = 'web', webOrigin?: string, voucherReservationId?: string): Promise<{ paymentUrl: string }> {
    if (actor.role !== Role.CUSTOMER) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the visit customer can pay it');
    if (voucherReservationId !== undefined) return this.createVoucherVnpayUrl('VISIT_GROUP', groupId, actor, ipAddr, platform, webOrigin, voucherReservationId);
    if ((await this.getPaymentMode()) !== PaymentMode.LIVE) throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Payment mode is not LIVE');
    const tmnCode = this.config.get<string>('VNPAY_TMN_CODE');
    const hashSecret = this.config.get<string>('VNPAY_HASH_SECRET');
    const vnpayPaymentUrl = this.config.get<string>('VNPAY_PAYMENT_URL');
    const returnUrl = this.config.get<string>('VNPAY_RETURN_URL');
    if (!tmnCode || !hashSecret || !vnpayPaymentUrl || !returnUrl) throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'VNPay is not configured');
    const payment = await this.dataSource.transaction(async (manager) => {
      await this.visitAccess(manager, groupId, actor, true);
      const charge = await this.readyVisitCharge(manager, groupId);
      await this.assertNoActiveCashIntent(manager, 'VISIT_GROUP', groupId);
      if (charge.total < 5000) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'VNPay chỉ áp dụng từ 5.000 ₫. Vui lòng chọn ví hoặc tiền mặt.');
      await this.assertNewCollectionAllowed(manager, groupId, 'VISIT_GROUP');
      return manager.save(VisitGroupPayment, manager.create(VisitGroupPayment, {
        visitGroupId: groupId, rail: 'vnpay', status: 'pending', amount: charge.total, allocations: charge.allocations,
        idempotencyKey: randomUUID().replace(/-/g, ''), requestedByUserId: actor.id, requestedAt: new Date(),
      }));
    });
    return {
      paymentUrl: buildPaymentUrl({
        paymentUrl: vnpayPaymentUrl,
        tmnCode,
        hashSecret,
        amount: Number(payment.amount),
        txnRef: payment.idempotencyKey,
        orderInfo: `Thanh toan luot sua ${groupId}${platform === 'mobile' ? ' mobile' : ''}`,
        returnUrl: platform === 'web' ? withWebOrigin(returnUrl, webOrigin) : returnUrl,
        ipAddr,
        createdAt: payment.requestedAt,
      }),
    };
  }

  /** The technician reports the cash of the whole visit, once; the customer then confirms it. */
  async declareVisitCash(groupId: string, dto: CashSettlementDeclarationDto, actor: FinanceActor, voucherReservationId?: string) {
    if (this.cashFirstEnabled() && !this.legacyCashCompatibilityEnabled()) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Vui lòng chờ khách chọn tiền mặt trước khi xác nhận đã nhận.');
    }
    if (actor.role !== Role.TECHNICIAN) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the assigned technician can declare cash received');
    if (voucherReservationId !== undefined) return this.declareVoucherVisitCash(groupId, dto, actor, voucherReservationId);
    return this.dataSource.transaction(async (manager) => {
      const group = await this.visitAccess(manager, groupId, actor, true);
      await lockCustodyTechnician(manager, actor.id);
      const charge = await this.readyVisitCharge(manager, groupId);
      await this.assertLegacyCashCompatibility(manager, 'VISIT_GROUP', groupId);
      await this.assertNewCollectionAllowed(manager, groupId, 'VISIT_GROUP');
      if (this.requireWholeVnd(dto.declaredAmount, 'Declared amount') !== charge.total) {
        throw new BusinessException(ErrorCodes.CASH_SETTLEMENT_MISMATCH, `Tiền mặt của cả lượt là ${charge.total.toLocaleString('vi-VN')}đ, vui lòng kiểm lại số tiền đã nhận.`);
      }
      const notes = dto.technicianNotes?.slice(0, 255) ?? null;
      const pending = await manager.findOne(VisitGroupPayment, {
        where: { visitGroupId: groupId, rail: 'cash', status: 'pending_confirmation' },
        order: { createdAt: 'DESC' },
      });
      // The group lock serializes retries. Reuse the same declaration rather than
      // replacing it and sending the customer another notification.
      if (pending && pending.requestedByUserId === actor.id && Number(pending.amount) === charge.total
          && pending.providerReference === notes && sameAllocations(pending.allocations, charge.allocations)) {
        return { id: pending.id, status: pending.status, amount: Number(pending.amount) };
      }
      await manager.update(VisitGroupPayment, { visitGroupId: groupId, rail: 'cash', status: 'pending_confirmation' }, { status: 'cancelled', failureCode: 'REDECLARED' });
      const payment = await manager.save(VisitGroupPayment, manager.create(VisitGroupPayment, {
        visitGroupId: groupId, rail: 'cash', status: 'pending_confirmation', amount: charge.total, allocations: charge.allocations,
        idempotencyKey: `CASH:${groupId}:${randomUUID()}`, requestedByUserId: actor.id, requestedAt: new Date(),
        providerReference: notes,
      }));
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'VISIT_CASH_DECLARED', resourceType: 'visit_group_payment', resourceId: payment.id, after: { amount: charge.total } });
      // The existing notification trigger publishes to this customer's socket
      // only after commit. Notification failure must roll back the declaration.
      await manager.insert(Notification, {
        userId: group.customerId,
        title: 'Xác nhận tiền mặt cho lượt sửa',
        message: 'Kỹ thuật viên đã báo nhận tiền mặt cho cả lượt sửa. Vui lòng kiểm tra số tiền và xác nhận.',
        type: 'VISIT_CASH_DECLARED',
        referenceType: 'VISIT_GROUP',
        referenceId: groupId,
        isRead: false,
      });
      return { id: payment.id, status: payment.status, amount: Number(payment.amount) };
    });
  }

  /**
   * The customer confirms the visit's cash, once: every repaired device's
   * invoice is paid by the same confirmed collection. Disagreeing opens a
   * cash mismatch case for the managers and pays nothing.
   */
  async confirmVisitCash(groupId: string, dto: CashSettlementConfirmationDto, actor: FinanceActor) {
    if (actor.role !== Role.CUSTOMER) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the visit customer can confirm cash payment');
    if (this.cashFirstEnabled() && await this.dataSource.getRepository(CashPaymentIntent).exists({
      where: { scopeKind: 'VISIT_GROUP', scopeId: groupId, status: In(['pending', 'received']) },
    })) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Yêu cầu tiền mặt mới không cần khách xác nhận lần nữa.');
    }
    const fundedPayment = await this.dataSource.getRepository(VisitGroupPayment).findOne({ where: {
      visitGroupId: groupId, rail: 'cash' }, order: { createdAt: 'DESC' } });
    if (fundedPayment) {
      const link = await this.findOptionalVoucherPaymentLink({ visitGroupPaymentId: fundedPayment.id });
      if (link) return this.confirmVoucherVisitCash(groupId, dto, actor, link.reservationId);
    }
    const result = await this.dataSource.transaction(async (manager) => {
      await this.visitAccess(manager, groupId, actor, true);
      const payment = await manager.findOne(VisitGroupPayment, { where: { visitGroupId: groupId, rail: 'cash', status: 'pending_confirmation' }, order: { createdAt: 'DESC' }, lock: { mode: 'pessimistic_write' } });
      if (!payment) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Thợ chưa báo nhận tiền mặt cho lượt này');
      const charge = await loadVisitCharge(manager, groupId, true);
      await this.assertLegacyCollectionAllowed(manager, groupId);
      const amount = Number(payment.amount);
      const agreed = dto.agreed === true && (dto.confirmedAmount === undefined || this.requireWholeVnd(dto.confirmedAmount, 'Confirmed amount') === amount);
      if (!agreed || !sameAllocations(payment.allocations, charge.allocations)) {
        payment.status = 'disputed';
        payment.failureCode = agreed ? 'ALLOCATION_CHANGED' : 'CUSTOMER_DISPUTED';
        await manager.save(payment);
        const [first] = payment.allocations;
        const order = first ? await manager.findOneBy(ServiceOrder, { id: first.serviceOrderId }) : null;
        await this.supportCasesService.openCase({
          caseType: SupportCaseType.CASH_MISMATCH,
          reason: 'Tiền mặt của lượt sửa nhiều máy chưa khớp',
          description: [`Lượt ${groupId}: thợ báo ${amount} VND`, dto.confirmedAmount === undefined ? null : `khách xác nhận ${dto.confirmedAmount} VND`, dto.disputeReason ?? null].filter(Boolean).join('; '),
          bookingId: order?.bookingId ?? null,
          serviceOrderId: order?.id ?? null,
          customerId: actor.id,
          technicianId: payment.requestedByUserId,
          createdByUserId: actor.id,
        }, manager);
        await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'VISIT_CASH_DISPUTED', resourceType: 'visit_group_payment', resourceId: payment.id, after: { amount, confirmedAmount: dto.confirmedAmount ?? null } });
        return { payment, mismatch: true };
      }
      const now = new Date();
      for (const allocation of payment.allocations) {
        const order = await manager.findOneOrFail(ServiceOrder, { where: { id: allocation.serviceOrderId }, lock: { mode: 'pessimistic_write' } });
        const invoice = await manager.findOneOrFail(Invoice, { where: { id: allocation.invoiceId } });
        const settlement = await manager.save(CashSettlement, manager.create(CashSettlement, {
          serviceOrderId: order.id, declaredByTechnicianId: payment.requestedByUserId, declaredAmount: allocation.amount, declaredAt: payment.requestedAt,
          status: CashSettlementStatus.CONFIRMED, confirmedByCustomerId: actor.id, confirmedAmount: allocation.amount, confirmedAt: now,
          technicianNotes: `Thu chung lượt sửa ${groupId}`,
        }));
        await this.applyConfirmedCash(manager, { order, invoice, settlement, actor, now });
      }
      await this.cancelOpenVisitPayments(manager, groupId, 'CASH_CONFIRMED');
      payment.status = 'verified';
      payment.verifiedAt = now;
      await manager.save(payment);
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'VISIT_PAYMENT_VERIFIED', resourceType: 'visit_group_payment', resourceId: payment.id, after: { rail: 'cash', amount, invoices: payment.allocations.length } });
      return { payment, mismatch: false };
    });
    if (result.mismatch) throw new BusinessException(ErrorCodes.CASH_SETTLEMENT_MISMATCH, 'Cash amount was not confirmed; support review is required');
    return { id: result.payment.id, status: result.payment.status, amount: Number(result.payment.amount) };
  }

  /** VNPay IPN for a visit payment (the txnRef is not an invoice payment's). The signature is already verified. */
  private async handleVisitVnpayIpn(query: Record<string, string>): Promise<{ RspCode: string; Message: string }> {
    const payment = await this.dataSource.getRepository(VisitGroupPayment).findOneBy({ idempotencyKey: query.vnp_TxnRef, rail: 'vnpay' });
    if (!payment) return { RspCode: '01', Message: 'Order not found' };
    const fundedLink = await this.findOptionalVoucherPaymentLink({ visitGroupPaymentId: payment.id });
    if (fundedLink) return this.handleVoucherVnpayIpn(fundedLink.reservationId, query);
    if (payment.status !== 'pending') return { RspCode: '02', Message: 'Order already confirmed' };
    const vnpAmount = Number(query.vnp_Amount) / 100;
    if (!Number.isSafeInteger(vnpAmount) || vnpAmount !== Number(payment.amount)) return { RspCode: '04', Message: 'Invalid amount' };
    if (query.vnp_ResponseCode === '00' && query.vnp_TransactionStatus === '00') {
      await this.applyVisitVnpay(payment.id, query.vnp_TransactionNo || query.vnp_TxnRef);
    } else {
      await this.dataSource.getRepository(VisitGroupPayment).update({ id: payment.id, status: 'pending' }, { status: 'failed', failureCode: `VNPAY_${query.vnp_ResponseCode ?? 'UNKNOWN'}` });
    }
    return { RspCode: '00', Message: 'Confirm Success' };
  }

  /**
   * A verified VNPay visit payment pays every invoice it froze, in one
   * transaction. When the split no longer matches (an invoice was paid some
   * other way meanwhile) nothing is applied and the payment is held as failed
   * with ALLOCATION_CHANGED for the managers to reconcile; never a double payment.
   */
  private async applyVisitVnpay(paymentId: string, providerReference: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // The visit row first, as every visit payment takes it, then the attempt.
      const ref = await manager.findOneBy(VisitGroupPayment, { id: paymentId });
      if (!ref) return;
      await manager.findOne(VisitGroup, { where: { id: ref.visitGroupId }, lock: { mode: 'pessimistic_write' } });
      const payment = await manager.findOne(VisitGroupPayment, { where: { id: paymentId }, lock: { mode: 'pessimistic_write' } });
      if (!payment || payment.status !== 'pending') return;
      const charge = await loadVisitCharge(manager, payment.visitGroupId, true);
      if (!sameAllocations(payment.allocations, charge.allocations)) {
        payment.status = 'failed';
        payment.failureCode = 'ALLOCATION_CHANGED';
        payment.providerReference = providerReference.slice(0, 255);
        await manager.save(payment);
        this.logger.warn(`VNPay visit payment ${payment.id} verified but its invoices changed; held for reconciliation`);
        return;
      }
      const now = new Date();
      for (const allocation of payment.allocations) {
        const invoice = await manager.findOneOrFail(Invoice, { where: { id: allocation.invoiceId } });
        await manager.update(Payment, { invoiceId: invoice.id, status: PaymentAttemptStatus.PENDING }, { status: PaymentAttemptStatus.CANCELLED, failureCode: 'PAID_BY_VISIT' });
        await manager.save(Payment, manager.create(Payment, {
          invoiceId: invoice.id, commissionDueId: null, purpose: PaymentPurpose.INVOICE, amount: allocation.amount, currency: 'VND',
          mode: PaymentMode.LIVE, provider: 'vnpay', status: PaymentAttemptStatus.VERIFIED, idempotencyKey: `${payment.idempotencyKey}:${invoice.id}`,
          providerReference: `${providerReference}:${invoice.id}`.slice(0, 255), requestedByUserId: payment.requestedByUserId, failureCode: null, requestedAt: payment.requestedAt, verifiedAt: now,
        }));
        await this.markInvoicePaidOnline(manager, invoice, payment.requestedByUserId, now);
      }
      await this.cancelOpenVisitPayments(manager, payment.visitGroupId, 'PAID_BY_VNPAY', payment.id);
      payment.status = 'verified';
      payment.verifiedAt = now;
      payment.providerReference = providerReference.slice(0, 255);
      await manager.save(payment);
      await this.auditLogService.logWithManager(manager, { actorUserId: payment.requestedByUserId, actorRole: Role.CUSTOMER, action: 'VISIT_PAYMENT_VERIFIED', resourceType: 'visit_group_payment', resourceId: payment.id, after: { rail: 'vnpay', amount: Number(payment.amount), invoices: payment.allocations.length } });
    });
  }

  /** Browser return leg of a visit payment: one best-effort querydr, like an invoice's. */
  private async handleVisitVnpayReturn(query: Record<string, string>, hashSecret: string) {
    const payment = await this.dataSource.getRepository(VisitGroupPayment).findOneBy({ idempotencyKey: query.vnp_TxnRef, rail: 'vnpay' });
    if (!payment) return { ok: false, invoiceId: null, serviceOrderId: null };
    if (query.vnp_ResponseCode === '00' && payment.status === 'pending') {
      await this.reconcileVisitVnpay(payment, hashSecret).catch((error) => {
        this.logger.warn(`VNPay visit querydr reconciliation failed: ${(error as Error)?.message}`);
      });
    }
    return {
      ok: query.vnp_ResponseCode === '00',
      invoiceId: null,
      serviceOrderId: payment.allocations[0]?.serviceOrderId ?? null,
      visitGroupId: payment.visitGroupId,
      purpose: PaymentPurpose.INVOICE,
      amount: Number(payment.amount),
      orderInfo: query.vnp_OrderInfo,
      payerRole: Role.CUSTOMER,
    };
  }

  private async reconcileVisitVnpay(payment: VisitGroupPayment, hashSecret: string): Promise<void> {
    const tmnCode = this.config.get<string>('VNPAY_TMN_CODE');
    const queryDrUrl = this.config.get<string>('VNPAY_QUERYDR_URL');
    if (!tmnCode || !queryDrUrl) return;
    const body = buildQueryDrRequest({ tmnCode, hashSecret, txnRef: payment.idempotencyKey, orderInfo: `Thanh toan luot sua ${payment.visitGroupId}`, transactionDate: payment.requestedAt, ipAddr: '127.0.0.1' });
    const response = await firstValueFrom(this.httpService.post(queryDrUrl, body).pipe(timeout(8000)));
    const data = response.data as Record<string, string>;
    if (data?.vnp_ResponseCode === '00' && data?.vnp_TransactionStatus === '00' && Number(data.vnp_Amount) / 100 === Number(payment.amount)) {
      const fundedLink = await this.findOptionalVoucherPaymentLink({ visitGroupPaymentId: payment.id });
      if (fundedLink) {
        await this.handleVnpayIpn(data);
        return;
      }
      await this.applyVisitVnpay(payment.id, data.vnp_TransactionNo || payment.idempotencyKey);
    }
  }

  /** The visit, readable by its customer and by the technician holding one of its orders; locked for a payment. */
  private async visitAccess(manager: EntityManager, groupId: string, actor: FinanceActor, lock = false): Promise<VisitGroup> {
    const group = await manager.findOne(VisitGroup, { where: { id: groupId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (group && actor.role === Role.CUSTOMER && group.customerId === actor.id) return group;
    if (group && actor.role === Role.TECHNICIAN) {
      const held = await manager.createQueryBuilder(TechnicianAssignment, 'a')
        .innerJoin(ServiceOrder, 'o', 'o.id = a.service_order_id')
        .innerJoin(Booking, 'b', 'b.id = o.booking_id')
        .where('a.technician_id = :technicianId AND a.is_active = true AND b.visit_group_id = :groupId', { technicianId: actor.id, groupId })
        .getCount();
      if (held) return group;
    }
    throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Visit group not found');
  }

  /** The visit's charge, refused while a device is still being worked on or when nothing is owed. */
  private async readyVisitCharge(manager: EntityManager, groupId: string): Promise<VisitCharge> {
    const charge = await loadVisitCharge(manager, groupId, true);
    if (charge.paid) throw new BusinessException(ErrorCodes.CONFLICT, 'Lượt sửa này đã thanh toán');
    if (charge.waiting > 0) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Còn thiết bị đang sửa, thanh toán khi mọi thiết bị đã có kết quả.');
    if (!charge.ready) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Lượt sửa này không có khoản nào cần thanh toán.');
    return charge;
  }

  private async cancelOpenVisitPayments(manager: EntityManager, groupId: string, code: string, exceptId?: string): Promise<void> {
    const query = manager.createQueryBuilder().update(VisitGroupPayment)
      .set({ status: 'cancelled', failureCode: code })
      .where('visit_group_id = :groupId AND status IN (:...open)', { groupId, open: ['pending', 'pending_confirmation'] });
    if (exceptId) query.andWhere('id != :exceptId', { exceptId });
    await query.execute();
  }

  /** A device of a visit is paid with the visit, never on its own invoice. */
  private refuseVisitInvoice(booking: { visitGroupId?: string | null } | null | undefined): void {
    if (booking?.visitGroupId) {
      throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Thiết bị này thuộc lượt sửa nhiều máy, thanh toán chung một lần cho cả lượt.', { visitGroupId: booking.visitGroupId });
    }
  }

  private async openCashMismatchCase(
    manager: EntityManager,
    order: ServiceOrder,
    invoice: Invoice,
    settlement: CashSettlement,
    actor: FinanceActor,
    customerId: string | null,
    customerAmount: number | null,
  ): Promise<void> {
    await this.supportCasesService.openCase(
      {
        caseType: SupportCaseType.CASH_MISMATCH,
        reason: 'Cash settlement amount does not match the server invoice',
        description: [
          `Invoice ${invoice.id} expected ${Number(invoice.grandTotal)} VND`,
          `technician declared ${Number(settlement.declaredAmount)} VND`,
          customerAmount === null ? null : `customer confirmed ${customerAmount} VND`,
        ]
          .filter(Boolean)
          .join('; '),
        bookingId: order.bookingId,
        serviceOrderId: order.id,
        customerId,
        technicianId: settlement.declaredByTechnicianId,
        createdByUserId: actor.id,
        evidenceRefs: settlement.receiptEvidenceUrl
          ? [settlement.receiptEvidenceUrl]
          : null,
      },
      manager,
    );
  }

  private requireWholeVnd(value: unknown, field: string): number {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999999) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        `${field} must be a whole VND amount`,
      );
    }
    return amount;
  }
}
