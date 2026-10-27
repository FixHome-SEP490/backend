import { CustomerWalletService } from '../customer-wallet/customer-wallet.service';
import { lockCustodyTechnician } from '../part-requests/part-custody.policy';
import { User } from '../users/entities/user.entity';
import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { firstValueFrom, timeout } from 'rxjs';
import { DataSource, EntityManager, Repository } from 'typeorm';
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
import { applyOrderCompletionEffects } from '../service-orders/order-completion-effects';
import { Payment } from './entities/payment.entity';
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

export interface FinanceActor {
  id: string;
  role: string;
}

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

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

  async createVnpayPaymentUrl(
    invoiceId: string,
    actor: FinanceActor,
    ipAddr: string,
    platform: 'web' | 'mobile' = 'web',
    webOrigin?: string,
  ): Promise<{ paymentUrl: string }> {
    if (actor.role !== Role.CUSTOMER) {
      throw new BusinessException(
        ErrorCodes.OWNERSHIP_DENIED,
        'Only the invoice customer can initiate payment',
      );
    }
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

  async declareCashSettlement(
    orderId: string,
    dto: CashSettlementDeclarationDto,
    actor: FinanceActor,
  ): Promise<ReturnType<typeof toCashSettlementResponse>> {
    if (actor.role !== Role.TECHNICIAN) {
      throw new BusinessException(
        ErrorCodes.OWNERSHIP_DENIED,
        'Only the assigned technician can declare cash received',
      );
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

      if (this.requireWholeVnd(invoice.grandTotal, 'Invoice amount') <= 0) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Hóa đơn 0 ₫ cần được khách hàng xác nhận miễn phí.');
      }

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
  async payInvoiceWithWallet(invoiceId: string, actor: FinanceActor): Promise<{ invoiceId: string; paid: true; amount: number; balance: number }> {
    if (actor.role !== Role.CUSTOMER) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the invoice customer can pay it');
    }
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
    params: { order: ServiceOrder; invoice: Invoice; settlement: CashSettlement; actor: FinanceActor; now: Date },
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

      await this.ensureCashPayment(manager, invoice, savedSettlement, actor.id, now);
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
        amount: this.requireWholeVnd(invoice.grandTotal, 'Invoice amount'),
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
  async payVisitWithWallet(groupId: string, actor: FinanceActor): Promise<{ visitGroupId: string; paid: true; amount: number; balance: number }> {
    if (actor.role !== Role.CUSTOMER) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the visit customer can pay it');
    if (!this.customerWalletService) throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Ví chưa sẵn sàng, vui lòng thử lại sau');
    const wallet = this.customerWalletService;
    return this.dataSource.transaction(async (manager) => {
      await this.visitAccess(manager, groupId, actor, true);
      const charge = await this.readyVisitCharge(manager, groupId);
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
  async createVisitVnpayUrl(groupId: string, actor: FinanceActor, ipAddr: string, platform: 'web' | 'mobile' = 'web', webOrigin?: string): Promise<{ paymentUrl: string }> {
    if (actor.role !== Role.CUSTOMER) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the visit customer can pay it');
    if ((await this.getPaymentMode()) !== PaymentMode.LIVE) throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Payment mode is not LIVE');
    const tmnCode = this.config.get<string>('VNPAY_TMN_CODE');
    const hashSecret = this.config.get<string>('VNPAY_HASH_SECRET');
    const vnpayPaymentUrl = this.config.get<string>('VNPAY_PAYMENT_URL');
    const returnUrl = this.config.get<string>('VNPAY_RETURN_URL');
    if (!tmnCode || !hashSecret || !vnpayPaymentUrl || !returnUrl) throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'VNPay is not configured');
    const payment = await this.dataSource.transaction(async (manager) => {
      await this.visitAccess(manager, groupId, actor, true);
      const charge = await this.readyVisitCharge(manager, groupId);
      if (charge.total < 5000) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'VNPay chỉ áp dụng từ 5.000 ₫. Vui lòng chọn ví hoặc tiền mặt.');
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
  async declareVisitCash(groupId: string, dto: CashSettlementDeclarationDto, actor: FinanceActor) {
    if (actor.role !== Role.TECHNICIAN) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Only the assigned technician can declare cash received');
    return this.dataSource.transaction(async (manager) => {
      const group = await this.visitAccess(manager, groupId, actor, true);
      await lockCustodyTechnician(manager, actor.id);
      const charge = await this.readyVisitCharge(manager, groupId);
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
    const result = await this.dataSource.transaction(async (manager) => {
      await this.visitAccess(manager, groupId, actor, true);
      const payment = await manager.findOne(VisitGroupPayment, { where: { visitGroupId: groupId, rail: 'cash', status: 'pending_confirmation' }, order: { createdAt: 'DESC' }, lock: { mode: 'pessimistic_write' } });
      if (!payment) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Thợ chưa báo nhận tiền mặt cho lượt này');
      const charge = await loadVisitCharge(manager, groupId, true);
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
