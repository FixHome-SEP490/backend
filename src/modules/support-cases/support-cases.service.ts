import { CustomerWalletService } from '../customer-wallet/customer-wallet.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { FinanceService } from '../finance/finance.service';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';
import {
  CreateSupportCaseDto,
  MySupportCaseDto,
  QueryMySupportCasesDto,
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
  COMPLAINT_RESOLUTION_CODES,
  SUPPORT_CASE_MAX_OPEN_PER_ORDER,
  allowedCaseTypes,
  isCompletionWindowOpen,
  respondByFor,
} from './support-case-policy';
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
  MAX_PAGE_SIZE,
} from '../../shared/constants';
import {
  CashSettlementStatus,
  PaymentStatus,
  Role,
  ServiceOrderStatus,
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
  isUrgent?: boolean;
  respondBy?: Date | null;
}

@Injectable()
export class SupportCasesService {
  private readonly logger = new Logger(SupportCasesService.name);

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
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly customerWalletService?: CustomerWalletService,
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
      isUrgent: input.isUrgent ?? false,
      respondBy: input.respondBy ?? null,
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

    const contextOrder =
      serviceOrder ??
      (booking
        ? await this.serviceOrderRepository.findOne({
            where: { bookingId: booking.id },
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
      // contextOrder covers a case opened with only the booking id; using
      // serviceOrder here lost the technician (not told, not shown the case).
      if (contextOrder) {
        const assignment = await this.assignmentRepository.findOne({
          where: {
            serviceOrderId: contextOrder.id,
            isActive: true,
          },
        });
        technicianId = assignment?.technicianId ?? null;
      }
    } else {
      if (!contextOrder) {
        throw new ForbiddenException(
          'Technicians can only open cases for an assigned service order context',
        );
      }
      const assignment = await this.assignmentRepository.findOne({
        where: {
          serviceOrderId: contextOrder.id,
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

    const orderStatus = contextOrder?.status ?? null;
    if (!allowedCaseTypes({
        role: actor.role as Role.CUSTOMER | Role.TECHNICIAN,
        orderStatus,
      }).includes(dto.caseType)) {
      throw new BadRequestException(
        'Loại khiếu nại này không áp dụng ở trạng thái hiện tại của đơn.',
      );
    }
    // "Cần thay đổi thợ" only after the technician has checked in on site.
    if (dto.caseType === SupportCaseType.TECHNICIAN_REPLACEMENT && contextOrder) {
      const checkedIn = await this.supportCaseRepository.manager.query(
        `SELECT 1 FROM "arrival_check_ins" WHERE "service_order_id" = $1 AND "technician_id" = $2 AND "result" = 'valid' LIMIT 1`,
        [contextOrder.id, actor.id],
      );
      if (!checkedIn.length) {
        throw new BadRequestException('Chỉ báo cần thay đổi thợ sau khi đã check-in tại nhà khách.');
      }
    }
    if (
      orderStatus === ServiceOrderStatus.COMPLETED &&
      !isCompletionWindowOpen(contextOrder?.completedAt)
    ) {
      throw new BadRequestException(
        'Đơn đã hoàn thành quá lâu, không còn nhận khiếu nại. Nếu còn hạn bảo hành, hãy gửi yêu cầu bảo hành.',
      );
    }
    if (contextOrder) {
      const openCount = await this.supportCaseRepository.count({
        where: {
          serviceOrderId: contextOrder.id,
          createdByUserId: actor.id,
          status: In([SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW]),
        },
      });
      if (openCount >= SUPPORT_CASE_MAX_OPEN_PER_ORDER) {
        throw new ConflictException(
          'Bạn đang có quá nhiều khiếu nại chưa xử lý cho đơn này. Vui lòng chờ quản lý dịch vụ phản hồi.',
        );
      }
    }

    const isUrgent = dto.isUrgent ?? false;
    const created = await this.openCase({
      caseType: dto.caseType,
      reason: dto.reason,
      description: dto.description ?? null,
      evidenceRefs: dto.evidenceRefs ?? null,
      bookingId,
      serviceOrderId: serviceOrderId ?? contextOrder?.id ?? null,
      customerId,
      technicianId,
      createdByUserId: actor.id,
      assignedManagerId: null,
      isUrgent,
      respondBy: respondByFor(orderStatus, isUrgent),
    });
    await this.notifyManagers(
      isUrgent ? 'Khiếu nại cần xử lý ngay' : 'Có khiếu nại mới',
      isUrgent
        ? 'Có khiếu nại được đánh dấu cần hỗ trợ ngay. Vui lòng xem xét.'
        : 'Có khiếu nại mới đang chờ tiếp nhận.',
      isUrgent ? 'SUPPORT_CASE_URGENT' : 'SUPPORT_CASE_OPENED',
      created.id,
    );
    return created;
  }

  async findMine(
    actor: SupportCaseActor,
    query: QueryMySupportCasesDto,
  ): Promise<{ data: MySupportCaseDto[]; total: number }> {
    const ownerColumn = this.ownerColumnFor(actor);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const qb = this.supportCaseRepository
      .createQueryBuilder('supportCase')
      .where(`supportCase.${ownerColumn} = :actorId`, { actorId: actor.id });

    if (query.status !== undefined) {
      qb.andWhere('supportCase.status = :status', { status: query.status });
    }
    if (query.serviceOrderId) {
      qb.andWhere('supportCase.serviceOrderId = :serviceOrderId', {
        serviceOrderId: query.serviceOrderId,
      });
    }
    qb.orderBy('supportCase.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [cases, total] = await qb.getManyAndCount();
    return { data: cases.map((c) => this.toMineDto(c, actor)), total };
  }

  async findMineById(
    id: string,
    actor: SupportCaseActor,
  ): Promise<MySupportCaseDto> {
    const ownerColumn = this.ownerColumnFor(actor);
    const supportCase = await this.supportCaseRepository.findOneBy({ id });
    // Same 404 for missing and foreign cases so ids cannot be probed.
    if (!supportCase || supportCase[ownerColumn] !== actor.id) {
      throw new NotFoundException(`Support case ${id} not found`);
    }
    return this.toMineDto(supportCase, actor);
  }

  private ownerColumnFor(actor: SupportCaseActor): 'customerId' | 'technicianId' {
    if (actor.role === Role.CUSTOMER) return 'customerId';
    if (actor.role === Role.TECHNICIAN) return 'technicianId';
    throw new ForbiddenException(
      'Only customers and technicians can read their own support cases',
    );
  }

  /** An actor reads the text of what they wrote; the other party's complaint shows only that it exists and its outcome. */
  private toMineDto(supportCase: SupportCase, actor: SupportCaseActor): MySupportCaseDto {
    const writtenByOther =
      !!supportCase.createdByUserId && supportCase.createdByUserId !== actor.id;
    return {
      id: supportCase.id,
      caseType: supportCase.caseType,
      status: supportCase.status,
      bookingId: supportCase.bookingId,
      serviceOrderId: supportCase.serviceOrderId,
      reason: writtenByOther
        ? 'Nội dung chỉ hiển thị cho người gửi và quản lý dịch vụ.'
        : supportCase.reason,
      description: writtenByOther ? null : supportCase.description,
      resolutionReason: supportCase.resolutionReason,
      evidenceRefs: writtenByOther ? null : supportCase.evidenceRefs,
      isUrgent: supportCase.isUrgent,
      respondBy: supportCase.respondBy,
      resolvedAt: supportCase.resolvedAt,
      createdAt: supportCase.createdAt,
      updatedAt: supportCase.updatedAt,
    };
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

    if (query?.sort === 'priority') {
      // enum order puts open/in_review before the final statuses
      qb.orderBy('supportCase.status', 'ASC')
        .addOrderBy('supportCase.isUrgent', 'DESC')
        .addOrderBy('supportCase.respondBy', 'ASC', 'NULLS LAST')
        .addOrderBy('supportCase.createdAt', 'DESC');
    } else {
      qb.orderBy('supportCase.createdAt', 'DESC');
    }
    qb.skip((page - 1) * limit).take(limit);

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

    let refunded: { customerId: string; amount: number; orderCode: string } | null = null;
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

        const isCashCase =
          supportCase.caseType === SupportCaseType.CASH_MISMATCH ||
          supportCase.caseType === SupportCaseType.CASH_NON_RESPONSE;
        if (
          !isCashCase &&
          !(COMPLAINT_RESOLUTION_CODES as readonly string[]).includes(resolutionCode)
        ) {
          throw new BadRequestException(
            `resolutionCode must be one of: ${COMPLAINT_RESOLUTION_CODES.join(', ')}`,
          );
        }

        const beforeStatus = supportCase.status;
        const updates: Partial<SupportCase> = {
          status: finalStatus,
          assignedManagerId: supportCase.assignedManagerId ?? actor.id,
          resolutionCode,
          resolutionReason: reason,
          evidenceRefs: evidenceRefs ?? supportCase.evidenceRefs ?? null,
          resolvedAt: new Date(),
          holdCompletion: false,
          liableParty: dto.liableParty ?? supportCase.liableParty ?? null,
          amount: dto.amount ?? supportCase.amount ?? null,
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
        if (resolutionCode === 'refund_to_wallet') {
          refunded = await this.refundToWallet(manager, supportCase, finalStatus, dto.amount);
        }

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
            liableParty: updates.liableParty ?? null,
            amount: updates.amount ?? null,
          },
        });

        Object.assign(supportCase, updates);
        return repository.findOneByOrFail({ id });
      },
    );

    await this.notifyParties(
      resolvedCase,
      'Khiếu nại đã được xử lý',
      'Quản lý dịch vụ đã xử lý khiếu nại liên quan đến đơn của bạn. Vui lòng xem kết quả.',
      'SUPPORT_CASE_RESOLVED',
    );
    const refund = refunded as { customerId: string; amount: number; orderCode: string } | null;
    if (refund && this.notificationsService) {
      await this.notificationsService.createNotification({
        userId: refund.customerId,
        title: 'Đã hoàn tiền vào ví',
        message: `${refund.amount.toLocaleString('vi-VN')} ₫ của đơn #${refund.orderCode} đã được hoàn vào ví FixHome của bạn, dùng để thanh toán lần sau.`,
        type: 'WALLET_REFUND',
        referenceId: resolvedCase.id,
        referenceType: 'SUPPORT_CASE',
      }).catch(() => undefined);
    }
    return this.toDetailDto(resolvedCase);
  }

  /**
   * Refund into the customer's wallet (PO 08/10/2026): only on a RESOLVED
   * complaint about an order the customer paid, never more in total than the
   * invoice. The invoice row lock serialises refunds of the same order.
   */
  private async refundToWallet(
    manager: EntityManager,
    supportCase: SupportCase,
    finalStatus: SupportCaseStatus,
    amount: number | undefined,
  ): Promise<{ customerId: string; amount: number; orderCode: string }> {
    if (!this.customerWalletService) {
      throw new ConflictException('Ví khách chưa sẵn sàng, chưa hoàn tiền được');
    }
    if (finalStatus !== SupportCaseStatus.RESOLVED) {
      throw new BadRequestException('Hoàn tiền vào ví chỉ dùng khi chấp nhận khiếu nại');
    }
    if (!Number.isSafeInteger(amount) || (amount as number) <= 0) {
      throw new BadRequestException('Nhập số tiền hoàn lớn hơn 0');
    }
    if (!supportCase.customerId || !supportCase.serviceOrderId) {
      throw new BadRequestException('Khiếu nại không gắn với đơn của khách nên không hoàn tiền được');
    }
    const invoice = await manager.findOne(Invoice, {
      where: { serviceOrderId: supportCase.serviceOrderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!invoice || invoice.paymentStatus !== PaymentStatus.PAID) {
      throw new BadRequestException('Đơn chưa thanh toán nên không có tiền để hoàn');
    }
    const paid = Number(invoice.grandTotal);
    const already = await this.customerWalletService.refundedForOrder(manager, supportCase.serviceOrderId);
    if (already + (amount as number) > paid) {
      throw new BadRequestException(
        `Tổng tiền hoàn vượt số khách đã trả (${paid.toLocaleString('vi-VN')} ₫, đã hoàn ${already.toLocaleString('vi-VN')} ₫)`,
      );
    }
    const order = await manager.findOne(ServiceOrder, { where: { id: supportCase.serviceOrderId } });
    const orderCode = order?.code ?? '';
    await this.customerWalletService.apply(manager, {
      userId: supportCase.customerId,
      type: 'refund',
      amount: amount as number,
      idempotencyKey: `REFUND:CASE_${supportCase.id}`,
      referenceType: 'SERVICE_ORDER',
      referenceId: supportCase.serviceOrderId,
      description: `Hoàn tiền khiếu nại đơn #${orderCode}`,
    });
    return { customerId: supportCase.customerId, amount: amount as number, orderCode };
  }

  /** Manager takes the case: OPEN becomes IN_REVIEW and the manager is recorded. */
  async startReview(id: string, actor: SupportCaseActor): Promise<SupportCaseDetailDto> {
    this.requireManager(actor);
    const updated = await this.supportCaseRepository.update(
      { id, status: SupportCaseStatus.OPEN },
      { status: SupportCaseStatus.IN_REVIEW, assignedManagerId: actor.id },
    );
    if (updated.affected !== 1) {
      await this.findById(id); // 404 when missing
      throw new ConflictException('Support case is no longer waiting for review');
    }
    await this.auditLogService.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'SUPPORT_CASE_REVIEW_STARTED',
      resourceType: 'support_case',
      resourceId: id,
      before: { status: SupportCaseStatus.OPEN },
      after: { status: SupportCaseStatus.IN_REVIEW },
    });
    return this.findById(id);
  }

  /** Hold (or release) automatic completion of the order while the case is unresolved. */
  async setHold(id: string, hold: boolean, actor: SupportCaseActor): Promise<SupportCaseDetailDto> {
    this.requireManager(actor);
    const supportCase = await this.supportCaseRepository.findOneBy({ id });
    if (!supportCase) throw new NotFoundException(`Support case ${id} not found`);
    if (!supportCase.serviceOrderId) {
      throw new BadRequestException('Only a case linked to a service order can hold its completion');
    }
    if (
      supportCase.status !== SupportCaseStatus.OPEN &&
      supportCase.status !== SupportCaseStatus.IN_REVIEW
    ) {
      throw new ConflictException('Support case is already terminal');
    }
    await this.supportCaseRepository.update({ id }, { holdCompletion: hold });
    await this.auditLogService.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: hold ? 'SUPPORT_CASE_HOLD_COMPLETION' : 'SUPPORT_CASE_RELEASE_COMPLETION',
      resourceType: 'support_case',
      resourceId: id,
      before: { holdCompletion: supportCase.holdCompletion },
      after: { holdCompletion: hold },
    });
    return this.findById(id);
  }

  private requireManager(actor: SupportCaseActor): void {
    if (actor.role !== Role.SERVICE_MANAGER) {
      throw new ForbiddenException('Only a service manager can review support cases');
    }
  }

  private async notifyManagers(title: string, message: string, type: string, caseId: string): Promise<void> {
    if (!this.notificationsService) return;
    try {
      const managers = await this.supportCaseRepository.manager.find(User, {
        where: { role: Role.SERVICE_MANAGER },
        select: ['id'],
      });
      await this.notificationsService.createManyNotifications(
        managers.map((manager) => ({
          userId: manager.id,
          title,
          message,
          type,
          referenceId: caseId,
          referenceType: 'SUPPORT_CASE',
        })),
      );
    } catch (error) {
      this.logger.warn(`Support case notification failed: ${(error as Error).message}`);
    }
  }

  private async notifyParties(supportCase: SupportCase, title: string, message: string, type: string): Promise<void> {
    if (!this.notificationsService) return;
    const userIds = [supportCase.customerId, supportCase.technicianId].filter((id): id is string => !!id);
    try {
      await this.notificationsService.createManyNotifications(
        userIds.map((userId) => ({
          userId,
          title,
          message,
          type,
          referenceId: supportCase.id,
          referenceType: 'SUPPORT_CASE',
        })),
      );
    } catch (error) {
      this.logger.warn(`Support case notification failed: ${(error as Error).message}`);
    }
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
      isUrgent: supportCase.isUrgent ?? false,
      respondBy: supportCase.respondBy ?? null,
      holdCompletion: supportCase.holdCompletion ?? false,
      liableParty: supportCase.liableParty ?? null,
      amount: supportCase.amount ?? null,
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

    // #23: an invoice already paid online has nothing left to settle in
    // cash; confirming cash here charged the technician a platform fee on
    // money FixHome already held.
    if (invoice.paymentStatus === PaymentStatus.PAID) {
      throw new ConflictException('Hoá đơn này đã được thanh toán online, không xác nhận tiền mặt được nữa.');
    }
    const order = await manager.getRepository(ServiceOrder).findOne({
      where: { id: supportCase.serviceOrderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!order) throw new NotFoundException('Service order not found');

    const now = new Date();
    settlement.status = CashSettlementStatus.CONFIRMED;
    settlement.confirmedByCustomerId = null;
    settlement.confirmedAmount = this.requireWholeVnd(invoice.grandTotal, 'Invoice amount');
    settlement.confirmedAt = now;
    settlement.resolvedByManagerId = actor.id;
    settlement.managerResolutionReason = reason;
    settlement.resolvedAt = now;
    const saved = await settlementRepository.save(settlement);
    // Same consequences as a customer confirmation (#9): the invoice formula,
    // dues and wallet settlement live in one place.
    const finance = this.moduleRef.get(FinanceService, { strict: false });
    await finance.applyConfirmedCash(manager, { order, invoice, settlement: saved, actor, now });
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
