import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes, FINANCE_COMMISSION_RATE } from '../../shared/constants';
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

export interface FinanceActor {
  id: string;
  role: string;
}

@Injectable()
export class FinanceService {
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
      const booking = await manager.findOne(Booking, {
        where: { id: order.bookingId },
      });
      if (!booking || booking.customerId !== actor.id) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Invoice not found');
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
      if (order.status !== ServiceOrderStatus.COMPLETED) {
        throw new BusinessException(
          ErrorCodes.ORDER_INVALID_TRANSITION,
          'Order must be completed before settling cash payment',
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
      invoice.paymentStatus = PaymentStatus.PAID;
      invoice.paidAt = now;
      await invoiceRepository.save(invoice);
      await orderRepository.update(
        { id: orderId },
        { paymentStatus: PaymentStatus.PAID },
      );
      await this.ensureCashPayment(manager, invoice, savedSettlement, actor.id, now);
      await this.ensureFinancialDues(manager, invoice, order, savedSettlement, now);
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
   * a canonical PlatformDue in PENDING status reachable through the
   * technician's commission/assignment history, or a legacy CommissionDue in
   * PENDING status. Bounded queries only; no cache, no mutation, no
   * ServiceOrder status change.
   */
  async hasActiveUnpaidPlatformDue(technicianId: string): Promise<boolean> {
    if (typeof technicianId !== 'string' || technicianId.trim().length === 0) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Technician id must be provided',
      );
    }

    const dues = await this.commissionDueRepository.find({
      where: { technicianId },
      select: ['serviceOrderId', 'status'],
    });
    if (
      dues.some((due) => due.status === CommissionDueStatus.PENDING)
    ) {
      return true;
    }

    const assignments = await this.assignmentRepository.find({
      where: { technicianId },
      select: ['serviceOrderId'],
    });
    const orderIds = Array.from(
      new Set([
        ...dues.map((due) => due.serviceOrderId),
        ...assignments.map((assignment) => assignment.serviceOrderId),
      ]),
    );
    if (orderIds.length === 0) {
      return false;
    }

    const pendingPlatformDue = await this.platformDueRepository.findOne({
      where: {
        serviceOrderId: In(orderIds),
        status: PlatformDueStatus.PENDING,
      },
      select: ['id'],
    });
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

  private async getPaymentMode(): Promise<PaymentMode> {
    const raw = (await this.configService.getString('payment.mode', 'DEMO'))
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
        const orderRepository = manager.getRepository(ServiceOrder);
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
        if (order) await this.ensureFinancialDues(manager, invoice, order, null, now);
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
            : Role.CUSTOMER,
        action: 'PAYMENT_VERIFIED',
        resourceType: 'payment',
        resourceId: current.id,
        after: { purpose: current.purpose, amount: Number(current.amount) },
      });
      return saved;
    });
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
    const grandTotal = this.requireWholeVnd(invoice.grandTotal, 'Invoice amount');
    const commissionAmount = this.requireWholeVnd(
      invoice.commissionAmount,
      'Commission amount',
    );
    if (grandTotal !== laborTotal + partsTotal) {
      throw new BusinessException(
        ErrorCodes.CONFLICT,
        'Invoice total snapshot is inconsistent',
      );
    }
    if (commissionAmount !== Math.round(laborTotal * FINANCE_COMMISSION_RATE)) {
      throw new BusinessException(
        ErrorCodes.CONFLICT,
        'Invoice commission snapshot is inconsistent',
      );
    }
    const commissionRate = FINANCE_COMMISSION_RATE;
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
            status: CommissionDueStatus.PENDING,
            paidAt: null,
            dueDate,
          }),
        );
      }
    }

    const existingPlatformDue = await platformDueRepository.findOne({
      where: { serviceOrderId: order.id },
    });
    const platformAmount = commissionAmount + partsTotal;
    if (existingPlatformDue) {
      if (
        Number(existingPlatformDue.dueAmount) !== platformAmount ||
        Number(existingPlatformDue.fixHomePartsTotalSnapshot) !== partsTotal
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
        fixHomePartsTotalSnapshot: partsTotal,
        commissionRateSnapshot: commissionRate,
        commissionAmountSnapshot: commissionAmount,
        dueAmount: platformAmount,
        status: PlatformDueStatus.PENDING,
        settledAt: null,
      }),
    );
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
