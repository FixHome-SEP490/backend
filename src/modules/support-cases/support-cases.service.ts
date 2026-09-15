import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  CreateSupportCaseDto,
  SupportCaseBookingContextDto,
  SupportCaseCashSettlementContextDto,
  SupportCaseDetailDto,
  SupportCaseInvoiceContextDto,
  SupportCaseServiceOrderContextDto,
  SupportCaseSummaryDto,
  QuerySupportCasesDto,
  ResolveSupportCaseDto,
} from './dto';
import { SupportCase } from './entities';
import {
  SUPPORT_CASE_MAX_DESCRIPTION_LENGTH,
  SUPPORT_CASE_MAX_EVIDENCE_REF_LENGTH,
  SUPPORT_CASE_MAX_EVIDENCE_REFS,
  SUPPORT_CASE_MAX_REASON_LENGTH,
  SUPPORT_CASE_MAX_RESOLUTION_CODE_LENGTH,
  SUPPORT_CASE_MAX_RESOLUTION_REASON_LENGTH,
} from './support-case.constants';
import {
  CASH_SETTLEMENT_MANAGER_CONFIRMATION_CODE,
  DEFAULT_PAGE_SIZE,
  FINANCE_COMMISSION_RATE,
  MAX_PAGE_SIZE,
} from '../../shared/constants';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import { PlatformDue } from '../finance/entities/platform-due.entity';
import { Payment } from '../finance/entities/payment.entity';
import {
  CashSettlementStatus,
  CommissionDueStatus,
  PaymentAttemptStatus,
  PaymentMode,
  PaymentPurpose,
  PaymentStatus,
  PlatformDueStatus,
  Role,
  SUPPORT_CASE_FINAL_STATUSES,
  SupportCaseFinalStatus,
  SupportCaseStatus,
  SupportCaseType,
} from '../../shared/enums';

export interface SupportCaseActor {
  id: string;
  role: string;
}

export interface OpenSupportCaseInput {
  caseType: SupportCaseType;
  reason: string;
  description?: string | null;
  evidenceRefs?: string[] | null;
  bookingId?: string | null;
  serviceOrderId?: string | null;
  customerId?: string | null;
  technicianId?: string | null;
  createdByUserId?: string | null;
  assignedManagerId?: string | null;
}

@Injectable()
export class SupportCasesService {
  constructor(
    @InjectRepository(SupportCase)
    private readonly supportCaseRepository: Repository<SupportCase>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(ServiceOrder)
    private readonly serviceOrderRepository: Repository<ServiceOrder>,
    @InjectRepository(Invoice)
    private readonly invoiceRepository: Repository<Invoice>,
    @InjectRepository(CashSettlement)
    private readonly cashSettlementRepository: Repository<CashSettlement>,
    @InjectRepository(TechnicianAssignment)
    private readonly assignmentRepository: Repository<TechnicianAssignment>,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Internal creation hook for future exception integrations.
   * There is deliberately no public controller route for this operation.
   */
  async openCase(
    input: OpenSupportCaseInput,
    transactionManager?: EntityManager,
  ): Promise<SupportCase> {
    if (!Object.values(SupportCaseType).includes(input.caseType)) {
      throw new BadRequestException('Invalid support case type');
    }

    const repository = transactionManager?.getRepository(SupportCase) ??
      this.supportCaseRepository;
    const supportCase = repository.create({
      caseType: input.caseType,
      status: SupportCaseStatus.OPEN,
      bookingId: input.bookingId ?? null,
      serviceOrderId: input.serviceOrderId ?? null,
      customerId: input.customerId ?? null,
      technicianId: input.technicianId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      assignedManagerId: input.assignedManagerId ?? null,
      reason: this.requireBoundedText(
        input.reason,
        'reason',
        1,
        SUPPORT_CASE_MAX_REASON_LENGTH,
      ),
      description: this.optionalBoundedText(
        input.description,
        'description',
        SUPPORT_CASE_MAX_DESCRIPTION_LENGTH,
      ),
      resolutionCode: null,
      resolutionReason: null,
      evidenceRefs: this.normalizeEvidenceRefs(input.evidenceRefs),
      resolvedAt: null,
    });

    return repository.save(supportCase);
  }

  /**
   * Bounded public escalation path for authenticated Customer/Technician
   * actors (POST /support/cases). Validates ownership against the referenced
   * Booking/ServiceOrder, derives customerId/technicianId/createdByUserId
   * server-side, and always starts the case OPEN. Reads only; never mutates
   * Booking, ServiceOrder, payment, or cash settlement state and never
   * triggers a normal-flow transition. Manager/Admin resolution behavior is
   * unchanged.
   */
  async openCaseForActor(
    dto: CreateSupportCaseDto,
    actor: SupportCaseActor,
  ): Promise<SupportCase> {
    if (
      actor.role !== Role.CUSTOMER &&
      actor.role !== Role.TECHNICIAN
    ) {
      throw new ForbiddenException(
        'Only customers and technicians can open support cases',
      );
    }

    const bookingId = dto.bookingId ?? null;
    const serviceOrderId = dto.serviceOrderId ?? null;
    if (!bookingId && !serviceOrderId) {
      throw new BadRequestException(
        'At least one of bookingId or serviceOrderId is required',
      );
    }

    const booking = bookingId
      ? await this.bookingRepository.findOne({ where: { id: bookingId } })
      : null;
    if (bookingId && !booking) {
      throw new NotFoundException(`Booking ${bookingId} not found`);
    }

    const serviceOrder = serviceOrderId
      ? await this.serviceOrderRepository.findOne({
          where: { id: serviceOrderId },
        })
      : null;
    if (serviceOrderId && !serviceOrder) {
      throw new NotFoundException(`Service order ${serviceOrderId} not found`);
    }

    if (booking && serviceOrder && serviceOrder.bookingId !== booking.id) {
      throw new BadRequestException(
        'Booking and service order do not belong to the same flow',
      );
    }

    const effectiveBooking =
      booking ??
      (serviceOrder
        ? await this.bookingRepository.findOne({
            where: { id: serviceOrder.bookingId },
          })
        : null);

    let customerId: string | null = null;
    let technicianId: string | null = null;

    if (actor.role === Role.CUSTOMER) {
      if (!effectiveBooking || effectiveBooking.customerId !== actor.id) {
        throw new ForbiddenException(
          'Customers can only open cases for their own bookings or service orders',
        );
      }
      customerId = actor.id;
      if (serviceOrder) {
        const assignment = await this.assignmentRepository.findOne({
          where: {
            serviceOrderId: serviceOrder.id,
            isActive: true,
          },
        });
        technicianId = assignment?.technicianId ?? null;
      }
    } else {
      const assignedOrder = serviceOrder
        ? serviceOrder
        : booking
          ? await this.serviceOrderRepository.findOne({
              where: { bookingId: booking.id },
            })
          : null;
      if (!assignedOrder) {
        throw new ForbiddenException(
          'Technicians can only open cases for an assigned service order context',
        );
      }
      const assignment = await this.assignmentRepository.findOne({
        where: {
          serviceOrderId: assignedOrder.id,
          technicianId: actor.id,
          isActive: true,
        },
      });
      if (!assignment) {
        throw new ForbiddenException(
          'Technicians can only open cases for service orders they are assigned to',
        );
      }
      technicianId = actor.id;
      customerId = effectiveBooking?.customerId ?? null;
    }

    return this.openCase({
      caseType: dto.caseType,
      reason: dto.reason,
      description: dto.description ?? null,
      evidenceRefs: dto.evidenceRefs ?? null,
      bookingId,
      serviceOrderId,
      customerId,
      technicianId,
      createdByUserId: actor.id,
      assignedManagerId: null,
    });
  }

  async findAll(
    query: QuerySupportCasesDto,
  ): Promise<{ data: SupportCaseSummaryDto[]; total: number }> {
    const page = query?.page ?? 1;
    const limit = Math.min(query?.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const qb = this.supportCaseRepository.createQueryBuilder('supportCase');

    if (query?.caseType !== undefined) {
      qb.andWhere('supportCase.caseType = :caseType', {
        caseType: query.caseType,
      });
    }
    if (query?.status !== undefined) {
      qb.andWhere('supportCase.status = :status', { status: query.status });
    }
    if (query?.bookingId) {
      qb.andWhere('supportCase.bookingId = :bookingId', {
        bookingId: query.bookingId,
      });
    }
    if (query?.serviceOrderId) {
      qb.andWhere('supportCase.serviceOrderId = :serviceOrderId', {
        serviceOrderId: query.serviceOrderId,
      });
    }
    if (query?.assignedManagerId) {
      qb.andWhere('supportCase.assignedManagerId = :assignedManagerId', {
        assignedManagerId: query.assignedManagerId,
      });
    }
    if (query?.search) {
      const search = `%${query.search}%`;
      qb.andWhere(
        '(supportCase.reason ILIKE :search OR supportCase.description ILIKE :search OR supportCase.resolutionCode ILIKE :search)',
        { search },
      );
    }

    qb.orderBy('supportCase.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [cases, total] = await qb.getManyAndCount();
    return {
      data: cases.map((supportCase) => this.toSummaryDto(supportCase)),
      total,
    };
  }

  async findById(id: string): Promise<SupportCaseDetailDto> {
    const supportCase = await this.supportCaseRepository.findOneBy({ id });
    if (!supportCase) {
      throw new NotFoundException(`Support case ${id} not found`);
    }

    return this.toDetailDto(supportCase);
  }

  async resolveCase(
    id: string,
    dto: ResolveSupportCaseDto,
    actor: SupportCaseActor,
  ): Promise<SupportCaseDetailDto> {
    if (actor.role !== Role.SERVICE_MANAGER) {
      throw new ForbiddenException(
        'Only a service manager can resolve support cases',
      );
    }

    const finalStatus = this.validateFinalStatus(dto.finalStatus);
    const resolutionCode = this.requireBoundedText(
      dto.resolutionCode,
      'resolutionCode',
      1,
      SUPPORT_CASE_MAX_RESOLUTION_CODE_LENGTH,
    );
    const reason = this.requireBoundedText(
      dto.reason,
      'reason',
      10,
      SUPPORT_CASE_MAX_RESOLUTION_REASON_LENGTH,
    );
    const evidenceRefs =
      dto.evidenceRefs === undefined
        ? undefined
        : this.normalizeEvidenceRefs(dto.evidenceRefs);

    const resolvedCase = await this.supportCaseRepository.manager.transaction(
      async (manager: EntityManager) => {
        const repository = manager.getRepository(SupportCase);
        const supportCase = await repository.findOne({
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });

        if (!supportCase) {
          throw new NotFoundException(`Support case ${id} not found`);
        }
        if (
          supportCase.status !== SupportCaseStatus.OPEN &&
          supportCase.status !== SupportCaseStatus.IN_REVIEW
        ) {
          throw new ConflictException('Support case is already terminal');
        }

        const beforeStatus = supportCase.status;
        const updates: Partial<SupportCase> = {
          status: finalStatus,
          assignedManagerId: supportCase.assignedManagerId ?? actor.id,
          resolutionCode,
          resolutionReason: reason,
          evidenceRefs: evidenceRefs ?? supportCase.evidenceRefs ?? null,
          resolvedAt: new Date(),
        };

        const updateResult = await repository.update(
          {
            id,
            status: In([SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW]),
          },
          updates,
        );
        if (updateResult.affected !== 1) {
          throw new ConflictException('Support case is already terminal');
        }

        await this.applyCashSettlementResolution(
          manager,
          supportCase,
          finalStatus,
          resolutionCode,
          actor,
          reason,
        );

        await this.auditLogService.logWithManagerStrict(manager, {
          actorUserId: actor.id,
          actorRole: actor.role,
          action: 'SUPPORT_CASE_RESOLVE',
          resourceType: 'support_case',
          resourceId: id,
          before: { status: beforeStatus },
          after: {
            status: finalStatus,
            finalStatus,
            resolutionCode,
            reason,
          },
        });

        Object.assign(supportCase, updates);
        return repository.findOneByOrFail({ id });
      },
    );

    return this.toDetailDto(resolvedCase);
  }

  private async toDetailDto(
    supportCase: SupportCase,
  ): Promise<SupportCaseDetailDto> {
    const [booking, serviceOrder, invoice, cashSettlement] = await Promise.all([
      supportCase.bookingId
        ? this.bookingRepository.findOne({
            where: { id: supportCase.bookingId },
          })
        : Promise.resolve(null),
      supportCase.serviceOrderId
        ? this.serviceOrderRepository.findOne({
            where: { id: supportCase.serviceOrderId },
          })
        : Promise.resolve(null),
      supportCase.serviceOrderId
        ? this.invoiceRepository.findOne({
            where: { serviceOrderId: supportCase.serviceOrderId },
          })
        : Promise.resolve(null),
      supportCase.serviceOrderId
        ? this.cashSettlementRepository.findOne({
            where: { serviceOrderId: supportCase.serviceOrderId },
          })
        : Promise.resolve(null),
    ]);

    const detail: SupportCaseDetailDto = {
      ...this.toSummaryDto(supportCase),
      booking: booking ? this.toBookingContext(booking) : null,
      serviceOrder: serviceOrder
        ? this.toServiceOrderContext(serviceOrder)
        : null,
      invoice: invoice ? this.toInvoiceContext(invoice) : null,
      cashSettlement: cashSettlement
        ? this.toCashSettlementContext(cashSettlement)
        : null,
    };
    return detail;
  }

  private toSummaryDto(supportCase: SupportCase): SupportCaseSummaryDto {
    return {
      id: supportCase.id,
      caseType: supportCase.caseType,
      status: supportCase.status,
      bookingId: supportCase.bookingId ?? null,
      serviceOrderId: supportCase.serviceOrderId ?? null,
      customerId: supportCase.customerId ?? null,
      technicianId: supportCase.technicianId ?? null,
      createdByUserId: supportCase.createdByUserId ?? null,
      assignedManagerId: supportCase.assignedManagerId ?? null,
      reason: supportCase.reason,
      description: supportCase.description ?? null,
      resolutionCode: supportCase.resolutionCode ?? null,
      resolutionReason: supportCase.resolutionReason ?? null,
      evidenceRefs: supportCase.evidenceRefs
        ? [...supportCase.evidenceRefs]
        : null,
      resolvedAt: supportCase.resolvedAt ?? null,
      createdAt: supportCase.createdAt,
      updatedAt: supportCase.updatedAt,
    };
  }

  private toBookingContext(booking: Booking): SupportCaseBookingContextDto {
    return {
      id: booking.id,
      status: booking.status,
      customerId: booking.customerId,
      serviceId: booking.serviceId,
    };
  }

  private toServiceOrderContext(
    serviceOrder: ServiceOrder,
  ): SupportCaseServiceOrderContextDto {
    return {
      id: serviceOrder.id,
      code: serviceOrder.code,
      status: serviceOrder.status,
      paymentStatus: serviceOrder.paymentStatus,
      laborTotal: this.toSafeNumber(serviceOrder.laborTotal),
      partsTotal: this.toSafeNumber(serviceOrder.partsTotal),
      grandTotal: this.toSafeNumber(serviceOrder.grandTotal),
    };
  }

  private toInvoiceContext(invoice: Invoice): SupportCaseInvoiceContextDto {
    return {
      id: invoice.id,
      laborTotal: this.toSafeNumber(invoice.laborTotal),
      partsTotal: this.toSafeNumber(invoice.partsTotal),
      grandTotal: this.toSafeNumber(invoice.grandTotal),
      paymentStatus: invoice.paymentStatus,
      issuedAt: invoice.issuedAt,
      paidAt: invoice.paidAt ?? null,
    };
  }

  private toCashSettlementContext(
    settlement: CashSettlement,
  ): SupportCaseCashSettlementContextDto {
    return {
      id: settlement.id,
      status: settlement.status,
      declaredAmount: this.toSafeNumber(settlement.declaredAmount),
      confirmedAmount: this.toSafeNumber(settlement.confirmedAmount),
      declaredAt: settlement.declaredAt,
      confirmedAt: settlement.confirmedAt ?? null,
      technicianNotes: settlement.technicianNotes ?? null,
      receiptEvidenceUrl: settlement.receiptEvidenceUrl ?? null,
      disputeReason: settlement.disputeReason ?? null,
      disputedByCustomerId: settlement.disputedByCustomerId ?? null,
      disputedAt: settlement.disputedAt ?? null,
      resolvedByManagerId: settlement.resolvedByManagerId ?? null,
      managerResolutionReason: settlement.managerResolutionReason ?? null,
      resolvedAt: settlement.resolvedAt ?? null,
    };
  }

  private async applyCashSettlementResolution(
    manager: EntityManager,
    supportCase: SupportCase,
    finalStatus: SupportCaseStatus,
    resolutionCode: string,
    actor: SupportCaseActor,
    reason: string,
  ): Promise<void> {
    if (
      !supportCase.serviceOrderId ||
      (supportCase.caseType !== SupportCaseType.CASH_MISMATCH &&
        supportCase.caseType !== SupportCaseType.CASH_NON_RESPONSE)
    ) {
      return;
    }

    if (
      finalStatus !== SupportCaseStatus.RESOLVED ||
      resolutionCode !== CASH_SETTLEMENT_MANAGER_CONFIRMATION_CODE
    ) {
      return;
    }

    const settlementRepository = manager.getRepository(CashSettlement);
    const invoiceRepository = manager.getRepository(Invoice);
    const orderRepository = manager.getRepository(ServiceOrder);
    const commissionDueRepository = manager.getRepository(CommissionDue);
    const platformDueRepository = manager.getRepository(PlatformDue);
    const paymentRepository = manager.getRepository(Payment);
    const settlement = await settlementRepository.findOne({
      where: { serviceOrderId: supportCase.serviceOrderId },
      lock: { mode: 'pessimistic_write' },
    });
    const invoice = await invoiceRepository.findOne({
      where: { serviceOrderId: supportCase.serviceOrderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!settlement || !invoice) {
      throw new NotFoundException(
        'Cash settlement or invoice is not available for manager resolution',
      );
    }
    if (settlement.status === CashSettlementStatus.CONFIRMED) {
      throw new ConflictException('Cash settlement is already confirmed');
    }

    const now = new Date();
    const invoiceAmount = this.requireWholeVnd(invoice.grandTotal, 'Invoice amount');
    const laborTotal = this.requireWholeVnd(invoice.laborTotal, 'Labor total');
    const partsTotal = this.requireWholeVnd(invoice.partsTotal, 'Parts total');
    const commissionAmount = this.requireWholeVnd(
      invoice.commissionAmount,
      'Commission amount',
    );
    if (invoiceAmount !== laborTotal + partsTotal) {
      throw new ConflictException('Invoice total snapshot is inconsistent');
    }
    if (commissionAmount !== Math.round(laborTotal * FINANCE_COMMISSION_RATE)) {
      throw new ConflictException('Invoice commission snapshot is inconsistent');
    }
    const commissionRate = FINANCE_COMMISSION_RATE;

    settlement.status = CashSettlementStatus.CONFIRMED;
    settlement.confirmedByCustomerId = null;
    settlement.confirmedAmount = invoiceAmount;
    settlement.confirmedAt = now;
    settlement.resolvedByManagerId = actor.id;
    settlement.managerResolutionReason = reason;
    settlement.resolvedAt = now;
    await settlementRepository.save(settlement);

    if (invoice.paymentStatus !== PaymentStatus.PAID) {
      invoice.paymentStatus = PaymentStatus.PAID;
      invoice.paidAt = now;
      await invoiceRepository.save(invoice);
      await orderRepository.update(
        { id: supportCase.serviceOrderId },
        { paymentStatus: PaymentStatus.PAID },
      );
    }

    const cashPaymentKey = `cash-settlement:${settlement.id}`;
    const existingCashPayment = await paymentRepository.findOne({
      where: { idempotencyKey: cashPaymentKey },
      lock: { mode: 'pessimistic_write' },
    });
    if (existingCashPayment) {
      if (
        existingCashPayment.invoiceId !== invoice.id ||
        existingCashPayment.purpose !== PaymentPurpose.INVOICE
      ) {
        throw new ConflictException(
          'Cash settlement payment reference is already bound to another payment',
        );
      }
    } else {
      await paymentRepository.save(
        paymentRepository.create({
          invoiceId: invoice.id,
          commissionDueId: null,
          purpose: PaymentPurpose.INVOICE,
          amount: invoiceAmount,
          currency: 'VND',
          mode: PaymentMode.DEMO,
          provider: null,
          status: PaymentAttemptStatus.VERIFIED,
          idempotencyKey: cashPaymentKey,
          providerReference: null,
          requestedByUserId: actor.id,
          failureCode: null,
          requestedAt: settlement.declaredAt ?? now,
          verifiedAt: now,
        }),
      );
    }

    if (supportCase.technicianId && commissionAmount > 0) {
      const existingDue = await commissionDueRepository.findOne({
        where: { serviceOrderId: supportCase.serviceOrderId },
      });
      if (existingDue) {
        if (
          Number(existingDue.laborTotalSnapshot) !== laborTotal ||
          Number(existingDue.commissionRateSnapshot) !== commissionRate ||
          Number(existingDue.dueAmount) !== commissionAmount
        ) {
          throw new ConflictException(
            'Historical commission snapshot cannot be changed',
          );
        }
      } else {
        const dueDate = new Date(now);
        dueDate.setDate(dueDate.getDate() + 7);
        await commissionDueRepository.save(
          commissionDueRepository.create({
            technicianId: supportCase.technicianId,
            serviceOrderId: supportCase.serviceOrderId,
            cashSettlementId: settlement.id,
            laborTotalSnapshot: laborTotal,
            commissionRateSnapshot: commissionRate,
            dueAmount: commissionAmount,
            status: CommissionDueStatus.PENDING,
            dueDate,
          }),
        );
      }
    }

    const existingPlatformDue = await platformDueRepository.findOne({
      where: { serviceOrderId: supportCase.serviceOrderId },
    });
    if (existingPlatformDue) {
      if (
        existingPlatformDue.invoiceId !== invoice.id ||
        Number(existingPlatformDue.laborTotalSnapshot) !== laborTotal ||
        Number(existingPlatformDue.fixHomePartsTotalSnapshot) !== partsTotal ||
        Number(existingPlatformDue.commissionRateSnapshot) !== commissionRate ||
        Number(existingPlatformDue.commissionAmountSnapshot) !== commissionAmount ||
        Number(existingPlatformDue.dueAmount) !== commissionAmount + partsTotal
      ) {
        throw new ConflictException(
          'Historical platform due snapshot cannot be changed',
        );
      }
    } else {
      await platformDueRepository.save(
        platformDueRepository.create({
          invoiceId: invoice.id,
          serviceOrderId: supportCase.serviceOrderId,
          laborTotalSnapshot: laborTotal,
          fixHomePartsTotalSnapshot: partsTotal,
          commissionRateSnapshot: commissionRate,
          commissionAmountSnapshot: commissionAmount,
          dueAmount: commissionAmount + partsTotal,
          status: PlatformDueStatus.PENDING,
        }),
      );
    }
  }

  private validateFinalStatus(
    status: SupportCaseFinalStatus,
  ): SupportCaseStatus {
    if (!SUPPORT_CASE_FINAL_STATUSES.includes(status)) {
      throw new BadRequestException(
        'Final status must be RESOLVED or REJECTED',
      );
    }
    return status;
  }

  private requireBoundedText(
    value: unknown,
    field: string,
    minLength: number,
    maxLength: number,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }
    const normalized = value.trim();
    if (normalized.length < minLength || normalized.length > maxLength) {
      throw new BadRequestException(
        `${field} must contain between ${minLength} and ${maxLength} characters`,
      );
    }
    return normalized;
  }

  private optionalBoundedText(
    value: string | null | undefined,
    field: string,
    maxLength: number,
  ): string | null {
    if (value === undefined || value === null) return null;
    return this.requireBoundedText(value, field, 1, maxLength);
  }

  private requireWholeVnd(value: unknown, field: string): number {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999999) {
      throw new BadRequestException(`${field} must be a whole VND amount`);
    }
    return amount;
  }

  private normalizeEvidenceRefs(value: unknown): string[] | null {
    if (value === undefined || value === null) return null;
    if (
      !Array.isArray(value) ||
      value.length > SUPPORT_CASE_MAX_EVIDENCE_REFS
    ) {
      throw new BadRequestException(
        `evidenceRefs must contain at most ${SUPPORT_CASE_MAX_EVIDENCE_REFS} references`,
      );
    }

    return value.map((ref, index) => {
      if (typeof ref !== 'string') {
        throw new BadRequestException(
          `evidenceRefs[${index}] must be a string`,
        );
      }
      const normalized = ref.trim();
      if (
        normalized.length === 0 ||
        normalized.length > SUPPORT_CASE_MAX_EVIDENCE_REF_LENGTH
      ) {
        throw new BadRequestException(
          `evidenceRefs[${index}] must contain between 1 and ${SUPPORT_CASE_MAX_EVIDENCE_REF_LENGTH} characters`,
        );
      }
      return normalized;
    });
  }

  private toSafeNumber(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const numberValue =
      typeof value === 'bigint' ? Number(value) : Number(value);
    if (
      !Number.isFinite(numberValue) ||
      Math.abs(numberValue) > Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }
    return numberValue;
  }
}
