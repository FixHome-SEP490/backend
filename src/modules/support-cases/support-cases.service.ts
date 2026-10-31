import { CustomerWalletService } from '../customer-wallet/customer-wallet.service';
import { isUUID } from 'class-validator';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
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
import { assertNoFundedVoucherRefund } from '../vouchers/voucher-refund-guard';
import { commitVerifiedVoucherSupportRefund } from '../vouchers/voucher-refund-commit';
import { VoucherPaymentLink } from '../vouchers/entities/voucher-funding.entity';
import { WalletService } from '../wallet/wallet.service';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Notification } from '../notifications/entities/notification.entity';
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
  SupportCaseTechnicianDelayDto,
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
  REFUND_CASE_TYPES,
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
  AccountStatus,
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

  /** The order lock serializes this hold with technician completion. */
  async requestStopOrReplace(orderId: string, reasonInput: string, actor: SupportCaseActor): Promise<SupportCase> {
    if (actor.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    const reason = this.requireBoundedText(reasonInput, 'reason', 10, SUPPORT_CASE_MAX_REASON_LENGTH);
    return this.supportCaseRepository.manager.transaction(async (manager: EntityManager) => {
      const reference = await manager.findOne(ServiceOrder, { where: { id: orderId } });
      if (!reference) throw new ForbiddenException('Order not found or access denied');
      const booking = await manager.findOne(Booking, {
        where: { id: reference.bookingId, customerId: actor.id }, lock: { mode: 'pessimistic_write' },
      });
      if (!booking) throw new ForbiddenException('Order not found or access denied');
      const order = await manager.findOne(ServiceOrder, { where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
      if (!order || order.bookingId !== booking.id) throw new ForbiddenException('Order not found or access denied');
      const existing = await manager.findOne(SupportCase, {
        where: { serviceOrderId: orderId, requestIntent: 'stop_or_replace', status: In([SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW]) },
      });
      if (existing) return existing;
      if (order.status !== ServiceOrderStatus.UNDER_REPAIR || order.completionRequestedAt) {
        throw new ConflictException('Đơn không còn ở giai đoạn có thể yêu cầu dừng sửa.');
      }
      const assignment = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: orderId, isActive: true } });
      if (!assignment) throw new ConflictException('Đơn không có kỹ thuật viên đang phụ trách.');
      const supportCase = await manager.save(SupportCase, manager.create(SupportCase, {
        caseType: SupportCaseType.MID_JOB_INTERRUPTION,
        status: SupportCaseStatus.OPEN, bookingId: booking.id, serviceOrderId: orderId,
        customerId: actor.id, technicianId: assignment.technicianId, createdByUserId: actor.id,
        reason, description: null, requestIntent: 'stop_or_replace', holdCompletion: true,
        workflowVersion: 0, isUrgent: true, respondBy: respondByFor(order.status, true),
      }));
      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: actor.id, actorRole: actor.role, action: 'CUSTOMER_STOP_REPLACE_REQUEST',
        resourceType: 'support_case', resourceId: supportCase.id,
        after: { serviceOrderId: orderId, requestIntent: 'stop_or_replace', holdCompletion: true },
      });
      const managers = await manager.find(User, {
        where: { role: Role.SERVICE_MANAGER, status: AccountStatus.ACTIVE, isActive: true }, select: { id: true },
      });
      if (managers.length) {
        await manager.insert(Notification, managers.map(user => ({
          userId: user.id, title: 'Khách yêu cầu dừng sửa hoặc đổi thợ',
          message: `Đơn #${order.code} cần quản lý xem xét.`, type: 'CUSTOMER_STOP_REPLACE_REQUEST',
          referenceId: supportCase.id, referenceType: 'SUPPORT_CASE',
        })));
      }
      return supportCase;
    });
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
      .where(`supportCase.${ownerColumn} = :actorId`, { actorId: actor.id })
      // A technician's delay report is for the manager; customers get a notice and a choice instead, and older apps do not know the type.
      .andWhere('supportCase.caseType <> :internalType', { internalType: SupportCaseType.TECHNICIAN_DELAY });

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
    if (!supportCase || supportCase[ownerColumn] !== actor.id || supportCase.caseType === SupportCaseType.TECHNICIAN_DELAY) {
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
      requestIntent: supportCase.requestIntent ?? null,
      ...(supportCase.requestIntent === 'stop_or_replace'
        ? { resolutionCode: supportCase.resolutionCode ?? null } : {}),
      holdCompletion: supportCase.holdCompletion ?? false,
      responsibility: supportCase.responsibility ?? null,
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
    if (dto.grossRefundVnd !== undefined && resolutionCode !== 'refund_to_wallet') {
      throw new BadRequestException('Gross refund basis is only valid for a wallet refund.');
    }
    const evidenceRefs =
      dto.evidenceRefs === undefined
        ? undefined
        : this.normalizeEvidenceRefs(dto.evidenceRefs);

    if (resolutionCode === 'escalate_admin') {
      return this.escalateAdmin(id, dto, actor, reason, evidenceRefs);
    }

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
        if ((supportCase.requestIntent === 'stop_or_replace' || supportCase.caseType === SupportCaseType.TECHNICIAN_REPLACEMENT)
          && ['worker_reassigned', 'order_cancelled_no_fee'].includes(resolutionCode)) {
          throw new ConflictException('Dùng lệnh resolve-interruption để cập nhật đơn và hồ sơ hỗ trợ cùng lúc.');
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
          workflowVersion: (supportCase.workflowVersion ?? 0) + 1,
          // A refund into the wallet is FixHome's to bear unless the manager says otherwise (PO 09/10/2026).
          liableParty: dto.liableParty ?? supportCase.liableParty ?? (resolutionCode === 'refund_to_wallet' ? 'platform' : null),
          amount: dto.amount ?? supportCase.amount ?? null,
          voucherGrossRefundVnd: dto.grossRefundVnd ?? supportCase.voucherGrossRefundVnd ?? null,
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

        const cashExecuted = await this.applyCashSettlementResolution(
          manager,
          supportCase,
          finalStatus,
          resolutionCode,
          actor,
          reason,
        );
        if (resolutionCode === 'refund_to_wallet') {
          refunded = await this.refundToWallet(manager, supportCase, finalStatus, dto.amount, dto.grossRefundVnd);
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
            workflowVersion: updates.workflowVersion,
            resolutionExecutionKind: refunded || cashExecuted ? 'DOMAIN_ACTION_EXECUTED' : 'DECISION_RECORDED',
          },
        });

        Object.assign(supportCase, updates);
        return repository.findOneByOrFail({ id });
      },
    );

    await this.notifyParties(
      resolvedCase,
      'Đã ghi nhận kết luận hỗ trợ',
      'Quản lý dịch vụ đã ghi nhận kết luận. Việc ghi nhận không tự thay đổi giá, bảo hành, hoàn tiền hoặc xử lý vi phạm; các thao tác đó chưa thực hiện nếu chưa có xác nhận riêng.',
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

  /** Existing resolve transport, but escalation is explicitly NON-terminal. */
  private async escalateAdmin(
    id: string, dto: ResolveSupportCaseDto, actor: SupportCaseActor,
    reason: string, evidenceRefs: string[] | null | undefined,
  ): Promise<SupportCaseDetailDto> {
    if (!isUUID(dto.commandId ?? '', '4') || !Number.isInteger(dto.expectedVersion)
      || dto.expectedVersion! < 0 || dto.expectedVersion! >= 2147483647
      || dto.finalStatus !== SupportCaseStatus.RESOLVED
      || dto.amount !== undefined || dto.liableParty !== undefined || dto.grossRefundVnd !== undefined) {
      throw new BadRequestException('escalate_admin cần commandId UUID và expectedVersion hiện tại; không nhận quyết định tiền hoặc trách nhiệm. Hồ sơ vẫn đang xem xét.');
    }
    if (evidenceRefs?.some(ref => !isUUID(ref, '4'))) {
      throw new BadRequestException('Chuyển xem xét chỉ nhận mã bằng chứng nội bộ, không nhận đường dẫn công khai.');
    }
    const commandId = dto.commandId!.toLowerCase();
    const refs = evidenceRefs?.map(ref => ref.toLowerCase()) ?? null;
    let replay = false;
    const escalated = await this.supportCaseRepository.manager.transaction(async manager => {
      const repository = manager.getRepository(SupportCase);
      const supportCase = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!supportCase) throw new NotFoundException('Support case not found');
      const events = await manager.find(AuditLog, {
        where: { resourceType: 'support_case', resourceId: id, action: 'SUPPORT_CASE_ESCALATE_ADMIN' },
      });
      const previous = events.filter(event => event.after?.commandId === commandId);
      if (previous.length > 1) throw new ConflictException('Escalation audit is ambiguous');
      if (previous.length === 1) {
        const event = previous[0];
        const proof = event.after!;
        if (event.actorRole !== Role.SERVICE_MANAGER || event.actorUserId !== actor.id
          || event.resourceId !== id || event.resourceType !== 'support_case'
          || event.action !== 'SUPPORT_CASE_ESCALATE_ADMIN' || !event.id || !event.createdAt
          || proof.reason !== reason || proof.expectedVersion !== dto.expectedVersion
          || proof.workflowVersion !== dto.expectedVersion! + 1
          || proof.status !== SupportCaseStatus.IN_REVIEW
          || Number(proof.workflowVersion) > supportCase.workflowVersion
          || JSON.stringify(proof.evidenceRefs) !== JSON.stringify(refs)) {
          throw new ConflictException('Escalation command does not match its recorded audit');
        }
        replay = true;
        return supportCase; // A replay never restores an older workflow state.
      }
      if (![SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW].includes(supportCase.status)
        || supportCase.workflowVersion !== dto.expectedVersion) {
        throw new ConflictException('Hồ sơ đã thay đổi hoặc kết thúc. Vui lòng tải lại phiên bản mới.');
      }
      const updates: Partial<SupportCase> = {
        status: SupportCaseStatus.IN_REVIEW,
        assignedManagerId: supportCase.assignedManagerId ?? actor.id,
        resolutionCode: 'escalate_admin', resolutionReason: reason, resolvedAt: null,
        workflowVersion: supportCase.workflowVersion + 1,
        // Hold and all domain state stay as recorded before escalation.
      };
      const result = await repository.update({ id, workflowVersion: dto.expectedVersion }, updates);
      if (result.affected !== 1) throw new ConflictException('Support case version changed');
      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: actor.id, actorRole: actor.role, action: 'SUPPORT_CASE_ESCALATE_ADMIN',
        resourceType: 'support_case', resourceId: id,
        before: { status: supportCase.status, workflowVersion: supportCase.workflowVersion,
          holdCompletion: supportCase.holdCompletion, resolutionCode: supportCase.resolutionCode,
          resolutionReason: supportCase.resolutionReason },
        after: { commandId, expectedVersion: dto.expectedVersion, workflowVersion: updates.workflowVersion,
          status: SupportCaseStatus.IN_REVIEW, reason, evidenceRefs: refs,
          holdCompletion: supportCase.holdCompletion, assignedManagerId: updates.assignedManagerId },
      });
      return repository.findOneByOrFail({ id });
    });
    if (!replay && this.notificationsService) {
      try {
        const admins = await this.supportCaseRepository.manager.find(User, {
          where: { role: Role.ADMIN, status: AccountStatus.ACTIVE }, select: ['id'],
        });
        await this.notificationsService.createManyNotifications(admins.map(admin => ({
          userId: admin.id, title: 'Hồ sơ hỗ trợ cần xem xét',
          message: 'Quản lý dịch vụ đã chuyển hồ sơ để quản trị viên xem xét ở chế độ chỉ đọc. Hồ sơ chưa kết thúc; quản lý dịch vụ tiếp tục phụ trách xử lý.',
          type: 'SUPPORT_CASE_ESCALATED_ADMIN', referenceId: id, referenceType: 'SUPPORT_CASE',
        })));
      } catch {
        this.logger.warn('Support case escalation notification failed');
      }
    }
    return this.toDetailDto(escalated);
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
    grossRefundVnd?: number,
  ): Promise<{ customerId: string; amount: number; orderCode: string }> {
    if (!this.customerWalletService) {
      throw new ConflictException('Ví khách chưa sẵn sàng, chưa hoàn tiền được');
    }
    if (finalStatus !== SupportCaseStatus.RESOLVED) {
      throw new BadRequestException('Hoàn tiền vào ví chỉ dùng khi chấp nhận khiếu nại');
    }
    if (!(REFUND_CASE_TYPES as readonly SupportCaseType[]).includes(supportCase.caseType)) {
      throw new BadRequestException('Chỉ hoàn tiền vào ví khi khiếu nại về linh kiện hỏng hoặc bảo hành');
    }
    if (!Number.isSafeInteger(amount) || (amount as number) < 0) {
      throw new BadRequestException('Nhập số tiền hoàn lớn hơn 0');
    }
    if (!supportCase.customerId || !supportCase.serviceOrderId) {
      throw new BadRequestException('Khiếu nại không gắn với đơn của khách nên không hoàn tiền được');
    }
    // Funded invoice: look up without acquiring an invoice write lock, so the
    // company campaign/reservation lock can be acquired first by the F3 helper.
    const invoiceReference = await manager.findOne(Invoice, {
      where: { serviceOrderId: supportCase.serviceOrderId },
    });
    if (!invoiceReference) {
      throw new BadRequestException('No invoice for this refund.');
    }
    // Missing funding table cannot be probed inside a transaction: 42P01
    // poisons the transaction even if caught. Check catalog first.
    const fundingTable = await manager.query(`SELECT to_regclass('public.voucher_payment_links') AS rel`);
    const hasFundingTable = fundingTable?.[0]?.rel !== null;
    let funded: { id: string }[] = [];
    try {
      if (hasFundingTable) funded = await manager.query(
        'SELECT id FROM public.voucher_payment_links WHERE allocation_snapshot @> $1::jsonb LIMIT 2',
        [JSON.stringify([{ invoiceId: invoiceReference.id }])],
      );
    } catch (error) {
      const sqlState = (error as { driverError?: { code?: string }; code?: string })?.driverError?.code
        ?? (error as { code?: string })?.code;
      if (sqlState !== '42P01') {
        throw new ConflictException('Voucher refund ledger is unavailable.');
      }
    }
    if (!Array.isArray(funded) || funded.length > 1) {
      throw new ConflictException('Voucher refund source is ambiguous.');
    }
    if (funded.length === 1) {
      // A manager must approve the original gross portion; amount stays the
      // customer NET. Both are validated against the frozen per-invoice ledger.
      if (!Number.isSafeInteger(grossRefundVnd) || (grossRefundVnd as number) <= 0) {
        throw new BadRequestException('Funded refund needs approved grossRefundVnd.');
      }
      let wallet: WalletService | undefined;
      try {
        wallet = this.moduleRef.get(WalletService, { strict: false });
      } catch {
        // Cash-funded reversals fail closed when the technician wallet is not available.
      }
      const result = await commitVerifiedVoucherSupportRefund(
        manager, supportCase.id, this.customerWalletService, wallet,
      );
      const order = await manager.findOne(ServiceOrder, { where: { id: supportCase.serviceOrderId } });
      return {
        customerId: supportCase.customerId,
        amount: result.customerRefundVnd,
        orderCode: order?.code ?? '',
      };
    }
    if (grossRefundVnd !== undefined) {
      throw new BadRequestException('Gross funded refund cannot be used for an ordinary invoice.');
    }
    if ((amount as number) <= 0) {
      throw new BadRequestException('An ordinary wallet refund must be positive.');
    }
    const invoice = await manager.findOne(Invoice, {
      where: { serviceOrderId: supportCase.serviceOrderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!invoice || invoice.paymentStatus !== PaymentStatus.PAID) {
      throw new BadRequestException('Đơn chưa thanh toán nên không có tiền để hoàn');
    }
    await assertNoFundedVoucherRefund(manager, invoice.id);
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
      { status: SupportCaseStatus.IN_REVIEW, assignedManagerId: actor.id, workflowVersion: () => '"workflow_version" + 1' },
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
    const updated = await this.supportCaseRepository.update(
      { id, status: In([SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW]) },
      { holdCompletion: hold, workflowVersion: () => '"workflow_version" + 1' },
    );
    if (updated.affected !== 1) throw new ConflictException('Support case is already terminal');
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
      technicianDelay: supportCase.caseType === SupportCaseType.TECHNICIAN_DELAY && serviceOrder
        ? await this.toTechnicianDelay(supportCase, serviceOrder)
        : null,
      invoice: invoice ? this.toInvoiceContext(invoice) : null,
      cashSettlement: cashSettlement
        ? this.toCashSettlementContext(cashSettlement)
        : null,
    };
    if (detail.resolutionExecutionKind === 'EXECUTION_NOT_VERIFIED') {
      // Code/status alone cannot attest that a specialized domain command ran.
      const events = await this.supportCaseRepository.manager.find(AuditLog, {
        where: { resourceType: 'support_case', resourceId: supportCase.id, action: 'SUPPORT_CASE_RESOLVE' },
      });
      const matching = events.filter(event => event.actorRole === Role.SERVICE_MANAGER && !!event.actorUserId
        && event.after?.resolutionExecutionKind === 'DOMAIN_ACTION_EXECUTED'
        && event.after?.resolutionCode === supportCase.resolutionCode
        && event.after?.status === SupportCaseStatus.RESOLVED
        && event.after?.workflowVersion === supportCase.workflowVersion);
      if (matching.length === 1) {
        detail.resolutionExecutionKind = 'DOMAIN_ACTION_EXECUTED';
        detail.needsManualAction = false;
        detail.nextActor = null;
      }
    }
    return detail;
  }

  private toSummaryDto(supportCase: SupportCase): SupportCaseSummaryDto {
    return {
      ...this.resolutionPresentation(supportCase),
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
      requestIntent: supportCase.requestIntent ?? null,
      workflowVersion: supportCase.workflowVersion ?? 0,
      reasonClass: supportCase.reasonClass ?? null,
      reasonCode: supportCase.reasonCode ?? null,
      responsibility: supportCase.responsibility ?? null,
      responsibilityActorId: supportCase.responsibilityActorId ?? null,
      responsibilityReason: supportCase.responsibilityReason ?? null,
      responsibilityEvidenceRefs: supportCase.responsibilityEvidenceRefs ?? null,
      responsibilityDecidedAt: supportCase.responsibilityDecidedAt ?? null,
      liableParty: supportCase.liableParty ?? null,
      amount: supportCase.amount ?? null,
      voucherGrossRefundVnd: supportCase.voucherGrossRefundVnd ?? null,
      createdAt: supportCase.createdAt,
      updatedAt: supportCase.updatedAt,
    };
  }

  private resolutionPresentation(supportCase: SupportCase): Pick<SupportCaseSummaryDto,
    'resolutionExecutionKind' | 'needsManualAction' | 'nextActor'> {
    const code = supportCase.resolutionCode;
    if (!code) return { resolutionExecutionKind: 'NOT_RECORDED', needsManualAction: false, nextActor: null };
    const open = [SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW].includes(supportCase.status);
    if (code === 'escalate_admin' && open && !supportCase.resolvedAt) {
      return { resolutionExecutionKind: 'ESCALATED_ADMIN', needsManualAction: true, nextActor: Role.ADMIN };
    }
    const specialized = supportCase.status === SupportCaseStatus.RESOLVED &&
      (code === 'refund_to_wallet' || (code === CASH_SETTLEMENT_MANAGER_CONFIRMATION_CODE
        && [SupportCaseType.CASH_MISMATCH, SupportCaseType.CASH_NON_RESPONSE].includes(supportCase.caseType)));
    const needsManualAction = specialized || !['no_action', 'warranty_upheld'].includes(code);
    return { resolutionExecutionKind: specialized ? 'EXECUTION_NOT_VERIFIED' : 'DECISION_RECORDED',
      needsManualAction, nextActor: needsManualAction ? Role.SERVICE_MANAGER : null };
  }

  private toBookingContext(booking: Booking): SupportCaseBookingContextDto {
    return {
      id: booking.id,
      status: booking.status,
      customerId: booking.customerId,
      serviceId: booking.serviceId,
    };
  }

  private async toTechnicianDelay(supportCase: SupportCase, order: ServiceOrder): Promise<SupportCaseTechnicianDelayDto> {
    const latest = order.delaySupportCaseId === supportCase.id;
    const currentOrderId = latest ? (order.delayCurrentOrderId ?? null) : null;
    const current = currentOrderId
      ? await this.supportCaseRepository.manager.findOne(ServiceOrder, { where: { id: currentOrderId }, select: { id: true, code: true } })
      : null;
    return {
      reasonCode: latest ? (order.delayReasonCode ?? null) : null,
      delayMinutes: latest ? (order.delayNoticeMinutes ?? null) : null,
      noticedAt: latest ? (order.delayNoticedAt ?? null) : null,
      decision: latest ? (order.delayDecision ?? null) : null,
      currentOrderId,
      currentOrderCode: current?.code ?? null,
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
  ): Promise<boolean> {
    if (
      !supportCase.serviceOrderId ||
      (supportCase.caseType !== SupportCaseType.CASH_MISMATCH &&
        supportCase.caseType !== SupportCaseType.CASH_NON_RESPONSE)
    ) {
      return false;
    }

    if (
      finalStatus !== SupportCaseStatus.RESOLVED ||
      resolutionCode !== CASH_SETTLEMENT_MANAGER_CONFIRMATION_CODE
    ) {
      return false;
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
    // The legacy manager path settles original gross without funding proof.
    // A funded dispute needs its own reconciled NET collection and subsidy;
    // never turn it into an ordinary gross cash confirmation here.
    if (await manager.findOne(VoucherPaymentLink, { where: { cashSettlementId: settlement.id } })) {
      throw new ConflictException('Tiền mặt có ưu đãi cần được đối soát theo số tiền thực thu.');
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
    return true;
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
