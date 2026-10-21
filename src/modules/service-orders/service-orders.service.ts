import { andWhereTextMatches } from '../../shared/utils/list-search';
import { NO_DEPARTURE_CANCEL_REASON } from './no-departure';
import { closeOrderPartRequests, assertPartsResolved, assertApprovedPartsResolved, usedPartQuantities, holderPartRequests, releaseOutgoingTechnicianPartRequests } from '../part-requests/part-request-lifecycle';
import { custodyUsageForInvoice, p1CustodyEnabled } from '../part-requests/part-custody.policy';
import { Payment } from '../finance/entities/payment.entity';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { Injectable, Logger, ForbiddenException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ReputationService } from '../reputation/reputation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { randomUUID } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, SelectQueryBuilder } from 'typeorm';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { OrderStatusHistory } from './entities/order-status-history.entity';
import { ArrivalCheckIn } from './entities/arrival-check-in.entity';
import { RepairEvidence } from './entities/repair-evidence.entity';
import { Cancellation } from './entities/cancellation.entity';
import { CancellationStrike } from './entities/cancellation-strike.entity';
import { Invoice } from './entities/invoice.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import { applyOrderCompletionEffects } from './order-completion-effects';
import { AdditionalCostRequest } from './entities/additional-cost-request.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { AdditionalCostItem } from './entities/additional-cost-item.entity';
import { CustomerServiceConfirmation } from './entities/customer-service-confirmation.entity';
import { BookingInvitation } from '../bookings/entities/booking-invitation.entity';
import { BookingInvitationGroup } from '../bookings/entities/booking-invitation-group.entity';
import { activateNextInvitation, invitationActivatedHook } from '../bookings/activate-next-invitation';
import { Booking } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { ServiceOrderStateMachine } from './service-order-state-machine';
import { closeBookingForCancelledOrder, departureWarningDue } from './close-cancelled-booking';
import { startBackgroundJob } from '../../common/background-job';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { haversineKm } from '../../shared/utils/geo';
import { normalizePhone } from '../../shared/validation/input.transforms';
import {
  ServiceOrderStatus,
  BookingStatus,
  InvitationStatus,
  CheckInResult,
  EvidenceType,
  CancelActor,
  CompensationStatus,
  StrikeStatus,
  PaymentStatus,
  QuotationStatus,
  AdditionalCostStatus,
  Role,
  CostItemType,
  ServicePricingMode,
  PartSource,
  PartWarrantyOption,
  PaymentAttemptStatus,
  CashSettlementStatus,
  PartRequestStatus,
  SupportCaseStatus,
  SupportCaseType,
} from '../../shared/enums';
import { orderStageSql, type RepairStage } from '../../shared/utils/customer-activity-stage';
import { BusinessConfigService } from '../system-config/business-config.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { FinanceService, FinanceActor } from '../finance/finance.service';
import { SettlementService } from '../wallet/settlement.service';
import {
  CashSettlementConfirmationDto,
  CashSettlementDeclarationDto,
  CommissionDueResponseDto,
  InitiatePaymentDto,
  InvoiceResponseDto,
  PaymentResponseDto,
  CashSettlementResponseDto,
} from '../finance/dto';
import type { EntityManager } from 'typeorm';
import { OrderEvidenceStorage, EvidenceFile, evidenceStampText } from '../media/order-evidence-storage.service';
import { expireAdditionalCosts } from './expire-additional-costs';
import { authorizeOrder } from './order-access';
import { groupSiblings, mirrorGroupStatus, recordVisitOutcome, refuseLoneGroupedBookingAction } from '../bookings/visit-group-guard';
import { REPAIR_FAILURE_REASONS, type RepairFailedDto } from './dto/repair-failed.dto';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { isCompletionHeld } from '../support-cases/completion-hold';
import { historicalOrderSummary, type HistoricalOrderSummary } from './historical-order-summary';
import { repairHistoryStatuses } from './repair-history-filter';
import { checkOverrunRelease, OVERRUN_RELEASE_WINDOW_DEFAULT_MINUTES, OVERRUN_RELEASE_WINDOW_KEY, type OverrunReleaseCheck } from './overrun-release';

/** A cancellation as the review list shows it: who cancelled, and which order. */
export type CancellationListItem = Cancellation & {
  actorName: string | null;
  actorRole: string | null;
  orderCode: string | null;
  /** Reputation points this cancellation cost whoever cancelled (negative), or null when it cost nothing. */
  reputationDelta: number | null;
};

/** A strike as the review list shows it: whose, and from which order. */
export type StrikeListItem = CancellationStrike & {
  userName: string | null;
  userRole: string | null;
  /** Until when the person may not book, when the strikes suspended them. */
  userSuspendedUntil: Date | null;
  serviceOrderId: string | null;
  orderCode: string | null;
};

/** One state, several states, and a text search over the order code, the service, the customer's and the technician's name. */
/** A coverage with the invoice line it covers (null on coverages without one). */
export type WarrantyCoverageView = WarrantyCoverage & {
  itemType: CostItemType | null;
  itemDescription: string | null;
};

function filterOrderList(
  qb: SelectQueryBuilder<ServiceOrder>,
  options: { status?: ServiceOrderStatus; statuses?: ServiceOrderStatus[]; search?: string },
): void {
  if (options.status) qb.andWhere('o.status = :status', { status: options.status });
  if (options.statuses?.length) qb.andWhere('o.status IN (:...statuses)', { statuses: options.statuses });
  if (options.search?.trim()) {
    qb.leftJoin('bookings', 'sb', 'sb.id = o.booking_id')
      .leftJoin('users', 'scu', 'scu.id = sb.customer_id')
      // The technician holding the order now (a customer looks for "the order with Toàn").
      .leftJoin('technician_assignments', 'sta', 'sta.service_order_id = o.id AND sta.is_active = true')
      .leftJoin('users', 'stu', 'stu.id = sta.technician_id');
    andWhereTextMatches(qb, ['o.code', 'sb.service_name_snapshot', 'scu.full_name', 'stu.full_name'], options.search);
  }
}

/** A paid order the sweep could not complete or settle is tried again after this long. */
const PAID_SWEEP_RETRY_MS = 15 * 60_000;

@Injectable()
export class ServiceOrdersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ServiceOrdersService.name);
  private departureTimer: NodeJS.Timeout | null = null;
  private settlementTimer: NodeJS.Timeout | null = null;
  /** When a paid order that could not complete or settle may be tried again (in memory, per instance). */
  private readonly paidSweepRetryAt = new Map<string, number>();

  onModuleInit(): void {
    this.departureTimer = startBackgroundJob('departure sweep', this.logger, () => this.sweepDepartures());
    this.settlementTimer = startBackgroundJob('paid order sweep', this.logger, async () => { await this.sweepPaidOrders(); });
  }

  onModuleDestroy(): void {
    if (this.departureTimer) clearInterval(this.departureTimer);
    if (this.settlementTimer) clearInterval(this.settlementTimer);
  }

  constructor(
    @InjectRepository(ServiceOrder)
    private readonly orderRepo: Repository<ServiceOrder>,
    @InjectRepository(TechnicianAssignment)
    private readonly assignmentRepo: Repository<TechnicianAssignment>,
    @InjectRepository(OrderStatusHistory)
    private readonly historyRepo: Repository<OrderStatusHistory>,
    @InjectRepository(ArrivalCheckIn)
    private readonly checkInRepo: Repository<ArrivalCheckIn>,
    @InjectRepository(RepairEvidence)
    private readonly evidenceRepo: Repository<RepairEvidence>,
    @InjectRepository(Cancellation)
    private readonly cancellationRepo: Repository<Cancellation>,
    @InjectRepository(CancellationStrike)
    private readonly strikeRepo: Repository<CancellationStrike>,
    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(InvoiceItem)
    private readonly invoiceItemRepo: Repository<InvoiceItem>,
    @InjectRepository(WarrantyCoverage)
    private readonly warrantyRepo: Repository<WarrantyCoverage>,
    @InjectRepository(AdditionalCostRequest)
    private readonly additionalCostRepo: Repository<AdditionalCostRequest>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(TechnicianProfile)
    private readonly techProfileRepo: Repository<TechnicianProfile>,
    @InjectRepository(CustomerServiceConfirmation)
    private readonly confirmationRepo: Repository<CustomerServiceConfirmation>,
    private readonly dataSource: DataSource,
    private readonly configService: BusinessConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly evidenceStorage: OrderEvidenceStorage,
    private readonly financeService: FinanceService,
    @Optional() private readonly settlementService?: SettlementService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly reputationService?: ReputationService,
  ) {}

  private async notifyCustomerForOrder(orderId: string, title: string, message: string, type: string): Promise<void> {
    if (!this.notificationsService) return;
    try {
      const order = await this.orderRepo.findOneBy({ id: orderId });
      if (!order) return;
      const booking = await this.dataSource.manager.findOneBy(Booking, { id: order.bookingId });
      if (!booking?.customerId) return;
      await this.notificationsService.createNotification({
        userId: booking.customerId,
        title,
        message,
        type,
        referenceId: order.id,
        referenceType: 'SERVICE_ORDER',
      });
    } catch {
      // Non-blocking notification dispatch
    }
  }

  // ── Queries ──

  /** Kept for the list endpoints, which still run the sweep lazily on read. */
  private async cancelOverdueOrders(): Promise<void> {
    await this.sweepDepartures();
  }

  /**
   * BRX-063 (PO 07/10/2026). The appointment time is the start of the
   * customer's window, or the acceptance if that came later. Once it has
   * passed (plus `order.departure_grace_minutes`) and the technician has not
   * set out, the technician and the customer are warned once; when
   * `order.departure_cancel_minutes` more pass and the technician has still
   * not set out, the order and the booking are cancelled and the cancellation
   * is recorded against the technician for the Service Manager's review.
   * Orders waiting for a replacement have no active assignment and are skipped.
   */
  async sweepDepartures(): Promise<void> {
    const graceMinutes = await this.configService.getInt('order.departure_grace_minutes', 0);
    const cancelMinutes = await this.configService.getInt('order.departure_cancel_minutes', 10);
    const now = Date.now();
    const accepted = () => this.orderRepo
      .createQueryBuilder('o')
      .innerJoin(Booking, 'b', 'b.id = o.booking_id')
      .innerJoin(TechnicianAssignment, 'ta', 'ta.service_order_id = o.id AND ta.is_active = true')
      .select('o.id', 'id')
      .where('o.status = :status', { status: ServiceOrderStatus.ACCEPTED });
    const toWarn: Array<{ id: string }> = await accepted()
      .andWhere('o.departure_warned_at IS NULL')
      .andWhere('GREATEST(COALESCE(b.preferred_start_at, o.scheduled_at), ta.assigned_at) <= :cutoff', { cutoff: new Date(now - graceMinutes * 60000) })
      .getRawMany();
    for (const { id } of toWarn) await this.warnNoDeparture(id, graceMinutes, cancelMinutes);
    const toCancel: Array<{ id: string }> = await accepted()
      .andWhere('o.departure_warned_at <= :cutoff', { cutoff: new Date(now - cancelMinutes * 60000) })
      .getRawMany();
    for (const { id } of toCancel) await this.cancelNoDeparture(id, cancelMinutes);
  }

  /**
   * PO 18/10/2026: once the customer has paid, the technician's share reaches
   * their wallet even when the order could not complete at that moment. Every
   * minute two kinds of order are picked up again:
   * - paid after the technician reported completion but still under repair: a
   *   complaint held completion at payment time and was settled later, or it
   *   was paid before 09/10/2026, when the customer still had to accept the work;
   * - completed and paid with nothing in the wallet ledger for it yet (paid
   *   before settlement existed, or settlement failed on the way).
   * Both go through the live gates (finalizeIfSatisfied, trySettleOrder), whose
   * row locks and idempotency keys keep a payment from being counted twice.
   * Orders whose settlement writes nothing (no share left after the platform's
   * part) are left out so they are not retried forever.
   */
  async sweepPaidOrders(limit = 20): Promise<{ completed: number; settled: number }> {
    let completed = 0;
    let settled = 0;
    const now = Date.now();
    // An order that still cannot complete (a quotation waiting, parts unresolved) waits a while
    // before the next try, so it never keeps newer orders out of the batch.
    const due = (id: string) => (this.paidSweepRetryAt.get(id) ?? 0) <= now;
    const backOff = (id: string) => this.paidSweepRetryAt.set(id, now + PAID_SWEEP_RETRY_MS);
    const stuck: Array<{ id: string }> = await this.dataSource.query(
      `SELECT o.id
         FROM service_orders o
         JOIN invoices i ON i.service_order_id = o.id AND i.payment_status::text = $1
        WHERE o.status::text = $2
          AND o.payment_status::text = $1
          AND o.completion_requested_at IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM support_cases sc
                 WHERE sc.service_order_id = o.id AND sc.hold_completion = true
                   AND sc.status::text IN ('open', 'in_review'))
        ORDER BY o.completion_requested_at ASC
        LIMIT $3`,
      [PaymentStatus.PAID, ServiceOrderStatus.UNDER_REPAIR, limit * 5],
    );
    for (const { id } of stuck.filter((row) => due(row.id)).slice(0, limit)) {
      try {
        const done = await this.dataSource.transaction(async manager => {
          const order = await manager.findOne(ServiceOrder, { where: { id }, lock: { mode: 'pessimistic_write' } });
          if (!order || await isCompletionHeld(manager, id)) return false;
          return this.finalizeIfSatisfied(manager, order, { id: null, role: 'system' });
        });
        if (done) {
          completed++;
          this.paidSweepRetryAt.delete(id);
        } else {
          backOff(id);
        }
      } catch (error) {
        backOff(id);
        this.logger.debug(`Paid order ${id} not completed yet: ${(error as Error).message}`);
      }
    }

    if (this.settlementService) {
      // Online: the technician's share is left to credit. Cash: the platform's part is still
      // owed (a PENDING platform due); a commission paid on its own is not taken twice.
      const unsettled: Array<{ id: string }> = await this.dataSource.query(
        `SELECT o.id
           FROM service_orders o
           JOIN invoices i ON i.service_order_id = o.id AND i.payment_status::text = $1
           LEFT JOIN cash_settlements cs ON cs.service_order_id = o.id
          WHERE o.status::text = $2
            AND EXISTS (SELECT 1 FROM technician_assignments ta WHERE ta.service_order_id = o.id)
            AND NOT EXISTS (
                  SELECT 1 FROM wallet_transactions t
                   WHERE t.reference_type = 'SERVICE_ORDER' AND t.reference_id = o.id::text)
            ${p1CustodyEnabled() ? `AND NOT EXISTS (
                  SELECT 1 FROM part_custody_payouts cp WHERE cp.service_order_id = o.id
                  GROUP BY cp.invoice_id HAVING count(DISTINCT cp.component) = 2)` : ''}
            AND CASE WHEN cs.status::text = $3
                     THEN EXISTS (SELECT 1 FROM platform_dues pd WHERE pd.service_order_id = o.id AND pd.status::text = 'pending')
                     ELSE i.grand_total - i.commission_amount - i.fixhome_parts_total - i.shipping_fee > 0 END
          ORDER BY o.completed_at ASC NULLS FIRST
          LIMIT $4`,
        [PaymentStatus.PAID, ServiceOrderStatus.COMPLETED, CashSettlementStatus.CONFIRMED, limit * 5],
      );
      for (const { id } of unsettled.filter((row) => due(row.id)).slice(0, limit)) {
        try {
          const result = await this.settlementService.trySettleOrder(id);
          if (result.settled && result.reason !== 'ALREADY_SETTLED') settled++;
          if (!result.settled) backOff(id);
        } catch (error) {
          backOff(id);
          this.logger.warn(`Paid order ${id} not settled: ${(error as Error).message}`);
        }
      }
    }
    if (completed || settled) this.logger.log(`Paid order sweep: ${completed} completed, ${settled} settled into the technician wallet`);
    return { completed, settled };
  }

  private async warnNoDeparture(id: string, graceMinutes: number, cancelMinutes: number): Promise<void> {
    const warned = await this.dataSource.transaction(async manager => {
      const ref = await manager.findOneBy(ServiceOrder, { id });
      if (!ref) return null;
      const booking = await manager.findOne(Booking, { where: { id: ref.bookingId }, lock: { mode: 'pessimistic_write' } });
      const order = await manager.findOne(ServiceOrder, { where: { id }, lock: { mode: 'pessimistic_write' } });
      const assignment = await manager.findOneBy(TechnicianAssignment, { serviceOrderId: id, isActive: true });
      if (!booking || !order || order.status !== ServiceOrderStatus.ACCEPTED || order.departureWarnedAt || !assignment) return null;
      const due = departureWarningDue(booking.preferredStartAt, order.scheduledAt, assignment.assignedAt, graceMinutes);
      if (!due || due.getTime() > Date.now()) return null;
      await manager.update(ServiceOrder, id, { departureWarnedAt: new Date() });
      await this.auditLogService.logWithManager(manager, { actorUserId: null, actorRole: 'system', action: 'ORDER_DEPARTURE_WARNING', resourceType: 'service_order', resourceId: id, after: { technicianId: assignment.technicianId, cancelAfterMinutes: cancelMinutes } });
      return { order, customerId: booking.customerId, technicianId: assignment.technicianId };
    });
    if (!warned || !this.notificationsService) return;
    const notify = (userId: string, title: string, message: string) => this.notificationsService!.createNotification({ userId, title, message, type: 'ORDER_DEPARTURE_WARNING', referenceId: warned.order.id, referenceType: 'SERVICE_ORDER' }).catch(() => undefined);
    void notify(warned.technicianId, 'Đã đến giờ hẹn', `Đơn #${warned.order.code} đã đến giờ hẹn mà bạn chưa bấm "Đang đến". Nếu sau ${cancelMinutes} phút bạn vẫn chưa xuất phát, đơn sẽ tự huỷ.`);
    if (warned.customerId) void notify(warned.customerId, 'Kỹ thuật viên chưa xuất phát', `Kỹ thuật viên của đơn #${warned.order.code} chưa xuất phát. Nếu sau ${cancelMinutes} phút vẫn chưa xuất phát, hệ thống sẽ huỷ đơn để bạn đặt lịch mới.`);
  }

  private async cancelNoDeparture(id: string, cancelMinutes: number): Promise<void> {
    const cancelled = await this.dataSource.transaction(async manager => {
      const ref = await manager.findOneBy(ServiceOrder, { id });
      if (!ref) return null;
      const booking = await manager.findOne(Booking, { where: { id: ref.bookingId }, lock: { mode: 'pessimistic_write' } });
      const order = await manager.findOne(ServiceOrder, { where: { id }, lock: { mode: 'pessimistic_write' } });
      const assignment = await manager.findOneBy(TechnicianAssignment, { serviceOrderId: id, isActive: true });
      if (!booking || !order || order.status !== ServiceOrderStatus.ACCEPTED || !order.departureWarnedAt || !assignment) return null;
      if (new Date(order.departureWarnedAt).getTime() + cancelMinutes * 60000 > Date.now()) return null;
      const reason = NO_DEPARTURE_CANCEL_REASON;
      await this.commitTransition(manager, order, ServiceOrderStatus.CANCELLED, { id: null, role: 'system' }, reason);
      await closeBookingForCancelledOrder(manager, booking.id);
      await manager.update(TechnicianAssignment, { serviceOrderId: id, isActive: true }, { isActive: false, unassignedAt: new Date(), unassignReason: reason });
      const cancellation = await manager.save(Cancellation, manager.create(Cancellation, { serviceOrderId: id, actor: CancelActor.TECHNICIAN, actorUserId: assignment.technicianId, reason, stateAtCancel: ServiceOrderStatus.ACCEPTED, strikeApplied: false, compensationStatus: CompensationStatus.NOT_ELIGIBLE }));
      await this.reputationService?.penalize(manager, { userId: assignment.technicianId, role: Role.TECHNICIAN, reason: `Không xuất phát đơn #${order.code} dù đã được nhắc`, serviceOrderId: id, cancellationId: cancellation.id });
      return { order, customerId: booking.customerId, technicianId: assignment.technicianId };
    });
    if (!cancelled || !this.notificationsService) return;
    const { order, customerId, technicianId } = cancelled;
    const notify = (userId: string, message: string) => this.notificationsService!.createNotification({ userId, title: 'Đơn hàng đã bị huỷ', message, type: 'ORDER_CANCELLED', referenceId: order.id, referenceType: 'SERVICE_ORDER' }).catch(() => undefined);
    if (customerId) void notify(customerId, `Đơn #${order.code} đã được huỷ vì kỹ thuật viên không xuất phát dù đã được nhắc. Bạn có thể đặt lịch mới.`);
    void notify(technicianId, `Đơn #${order.code} đã bị huỷ vì bạn không xuất phát sau khi được nhắc.`);
  }

  async findAll(options: {
    page?: number;
    limit?: number;
    status?: ServiceOrderStatus;
    statuses?: ServiceOrderStatus[];
    search?: string;
  }): Promise<{ data: ServiceOrder[]; total: number }> {
    await this.cancelOverdueOrders();
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.orderRepo.createQueryBuilder('o');

    filterOrderList(qb, options);

    qb.orderBy('o.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data: await Promise.all(data.map(order => this.presentOrder(order))), total };
  }

  async findMyOrders(
    userId: string,
    role: string,
    options: { page?: number; limit?: number; status?: ServiceOrderStatus; statuses?: ServiceOrderStatus[]; search?: string; stage?: RepairStage },
  ): Promise<{ data: (ServiceOrder | HistoricalOrderSummary)[]; total: number }> {
    await this.cancelOverdueOrders();
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.orderRepo.createQueryBuilder('o');

    if (role === Role.CUSTOMER) {
      qb.innerJoin('bookings', 'b', 'b.id = o.booking_id')
        .where('b.customer_id = :userId', { userId });
      if (options.stage) qb.andWhere(orderStageSql(options.stage, 'o'));
    } else if (role === Role.TECHNICIAN) {
      qb.innerJoin(
        'technician_assignments',
        'ta',
        'ta.service_order_id = o.id',
      ).where('ta.technician_id = :userId', { userId });
      // A job someone has stepped off (withdrew, was replaced) is history for them: it stays
      // under "all" and "cancelled", but no longer counts as work to travel to or do.
      const asked = options.statuses?.length ? options.statuses : options.status ? [options.status] : [];
      if (asked.length && !asked.includes(ServiceOrderStatus.CANCELLED)) qb.andWhere('ta.is_active = true');
    } else {
      throw new ForbiddenException('Order list access denied');
    }

    filterOrderList(qb, options);

    qb.orderBy('o.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return {
      data: await Promise.all(data.map(async order => {
        if (role !== Role.TECHNICIAN) return this.presentOrder(order);
        const assignment = await this.dataSource.manager.findOneBy(TechnicianAssignment, {
          serviceOrderId: order.id, technicianId: userId, isActive: true,
        });
        return assignment ? this.presentOrder(order) : historicalOrderSummary(order);
      })),
      total,
    };
  }

  async findById(
    id: string,
    actor: { id: string; role: string },
  ): Promise<ServiceOrder | HistoricalOrderSummary> {
    await this.cancelOverdueOrders();
    const order = await this.orderRepo.findOneBy({ id });
    if (!order) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Order not found');
    }
    if (actor.role === Role.TECHNICIAN) {
      const active = await this.dataSource.manager.findOneBy(TechnicianAssignment, {
        serviceOrderId: id, technicianId: actor.id, isActive: true,
      });
      if (active) return this.presentOrder(order);
      const historical = await this.dataSource.manager.findOneBy(TechnicianAssignment, {
        serviceOrderId: id, technicianId: actor.id,
      });
      if (historical) return historicalOrderSummary(order);
      throw new ForbiddenException('Order not found or access denied');
    }
    await this.checkOrderAccess(order, actor);
    return this.presentOrder(order);
  }

  /**
   * Public guest lookup by order code + registered phone (no auth).
   * Same generic not-found error whether the code or the phone is wrong,
   * to avoid letting a caller enumerate order codes.
   */
  async trackPublic(orderCode: string, phone: string) {
    const order = await this.orderRepo.findOneBy({ code: orderCode });
    if (!order) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Order not found');
    }
    const booking = await this.dataSource.manager.findOneBy(Booking, { id: order.bookingId });
    const customer = booking ? await this.dataSource.manager.findOneBy(User, { id: booking.customerId }) : null;
    if (!customer || customer.phoneNumber !== normalizePhone(phone)) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Order not found');
    }
    const presented = await this.presentOrder(order);
    const trackableStatus = presented.status === ServiceOrderStatus.EN_ROUTE || presented.status === ServiceOrderStatus.UNDER_REPAIR;
    return {
      code: presented.code,
      status: presented.status,
      serviceName: (presented as unknown as { serviceName?: string }).serviceName,
      technician: (presented as unknown as { technician?: { fullName: string; phoneNumber: string } }).technician,
      destination: (presented as unknown as { destination?: { lat: number; lng: number } | null }).destination,
      technicianLocation: trackableStatus ? (presented as unknown as { technicianLocation?: unknown }).technicianLocation : null,
      timeline: ((presented as unknown as { timeline: { status: string; timestamp: string }[] }).timeline)
        .map((t) => ({ status: t.status, timestamp: t.timestamp })),
    };
  }

  // ── State Transitions (D-22: all within transaction) ──

  /**
   * Transition to EN_ROUTE.
   */
  private async presentOrder(order: ServiceOrder): Promise<ServiceOrder> {
    const manager = this.dataSource.manager;
    const booking = await manager.findOneByOrFail(Booking, { id: order.bookingId });
    // The technician holding the order now. A technician who withdrew or was
    // replaced is not shown (name, phone, last GPS); a completed order keeps
    // its finishing technician because that assignment stays active.
    const assignment = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: order.id, isActive: true } })
      ?? (order.status === ServiceOrderStatus.COMPLETED
        ? await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: order.id }, order: { assignedAt: 'DESC' } })
        : null);
    const technician = assignment ? await manager.findOneBy(User, { id: assignment.technicianId }) : null;
    if (!assignment) {
      order.technicianLastLat = null;
      order.technicianLastLng = null;
      order.technicianLocationUpdatedAt = null;
    }
    const customer = await manager.findOneBy(User, { id: booking.customerId });
    const quotation = await manager.findOne(Quotation, { where: { serviceOrderId: order.id }, relations: ['items'], order: { version: 'DESC' } });
    const history = await this.historyRepo.find({ where: { serviceOrderId: order.id }, order: { createdAt: 'ASC' } });
    return Object.assign(order, {
      serviceName: booking.serviceNameSnapshot || '', addressSummary: booking.addressTextSnapshot || '',
      pricingMode: booking.pricingModeSnapshot,
      fixedUnitPrice: booking.fixedUnitPriceSnapshot ? Number(booking.fixedUnitPriceSnapshot) : null,
      quantity: booking.quantity || 1,
      scopeDescription: booking.scopeSnapshot || '',
      bookingDescription: booking.description || '',
      customerNote: booking.customerNote ?? null,
      bookingMode: booking.bookingMode ?? 'scheduled',
      slot: booking.slot ?? null,
      departAvailableAt: booking.preferredStartAt
        ? new Date(booking.preferredStartAt.getTime() - (await this.configService.getInt('order.depart_early_minutes', 60)) * 60_000).toISOString()
        : null,
      customerName: customer?.fullName || '', customerPhone: customer?.phoneNumber || '',
      technician: technician ? { id: technician.id, fullName: technician.fullName, phoneNumber: technician.phoneNumber } : undefined,
      destination: booking.latitudeSnapshot != null && booking.longitudeSnapshot != null
        ? { lat: Number(booking.latitudeSnapshot), lng: Number(booking.longitudeSnapshot) }
        : null,
      technicianLocation: order.technicianLastLat != null && order.technicianLastLng != null
        ? { lat: Number(order.technicianLastLat), lng: Number(order.technicianLastLng), updatedAt: order.technicianLocationUpdatedAt?.toISOString() ?? null }
        : null,
      quotation, customerConfirmed: !!await manager.findOneBy(CustomerServiceConfirmation, { serviceOrderId: order.id }),
      arrivalVerified: !!await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: order.id, technicianId: assignment?.technicianId, result: CheckInResult.VALID }),
      beforeEvidenceCount: await manager.count(RepairEvidence, { where: { serviceOrderId: order.id, type: EvidenceType.BEFORE } }),
      afterEvidenceCount: await manager.count(RepairEvidence, { where: { serviceOrderId: order.id, type: EvidenceType.AFTER } }),
      timeline: history.map(h => ({ status: h.toStatus, title: h.reason, timestamp: h.createdAt.toISOString(), actor: h.actorRole })),
    });
  }

  async enRoute(
    orderId: string,
    actor: { id: string; role: string },
  ): Promise<ServiceOrder> {
    // PO 08/10/2026: setting out is allowed from order.depart_early_minutes (60)
    // before the appointment; an urgent booking's appointment is its creation.
    const current = await this.orderRepo.findOneBy({ id: orderId });
    const booking = current ? await this.dataSource.manager.findOneBy(Booking, { id: current.bookingId }) : null;
    if (booking?.preferredStartAt) {
      const earlyMinutes = await this.configService.getInt('order.depart_early_minutes', 60);
      const opensAt = booking.preferredStartAt.getTime() - earlyMinutes * 60_000;
      if (Date.now() < opensAt) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, `Chỉ xuất phát được từ ${earlyMinutes} phút trước giờ hẹn`, { departAvailableAt: new Date(opensAt).toISOString() });
      }
    }
    const res = await this.transitionStatus(
      orderId,
      ServiceOrderStatus.EN_ROUTE,
      actor,
      'Technician en route',
    );
    // One trip for a visit of several devices (PO 21/10/2026): every order sets out together.
    for (const sibling of await this.visitSiblingOrders(this.dataSource.manager, res, actor.id, ServiceOrderStatus.ACCEPTED)) {
      await this.transitionStatus(sibling.id, ServiceOrderStatus.EN_ROUTE, actor, 'Technician en route (cả lượt)');
    }
    void this.notifyCustomerForOrder(
      orderId,
      'Kỹ thuật viên đang di chuyển',
      `Kỹ thuật viên đang trên đường đến địa chỉ của bạn cho đơn hàng #${res.code}.`,
      'TECHNICIAN_EN_ROUTE',
    );
    return res;
  }

  /**
   * GPS check-in. Creates ArrivalCheckIn record.
   */
  async checkIn(orderId: string, body: { lat: number; lng: number; accuracyMeters: number; deviceInfo?: Record<string, unknown> }, actor: { id: string; role: string }): Promise<ArrivalCheckIn> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (order.status !== ServiceOrderStatus.EN_ROUTE) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Order must be EN_ROUTE');
      const booking = await manager.findOneByOrFail(Booking, { id: order.bookingId });
      if (![body.lat, body.lng, body.accuracyMeters].every(Number.isFinite) || Math.abs(body.lat) > 90 || Math.abs(body.lng) > 180 || body.accuracyMeters < 0) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid GPS coordinates');
      if (booking.latitudeSnapshot == null || booking.longitudeSnapshot == null) throw new BusinessException(ErrorCodes.CHECKIN_OUT_OF_GEOFENCE, 'Repair address has no verified coordinates');
      const lat = Number(booking.latitudeSnapshot), lng = Number(booking.longitudeSnapshot);
      const distanceMeters = Math.round(haversineKm(lat, lng, body.lat, body.lng) * 1000);
      // PO 11/10/2026: browser GPS is often hundreds of metres off, so 5 km of distance and of
      // reported error both pass by default.
      const radius = await this.configService.getInt('geofence.radius_meters', 5000);
      const accuracy = await this.configService.getInt('geofence.min_gps_accuracy_meters', 5000);
      const result = body.accuracyMeters > accuracy ? CheckInResult.LOW_ACCURACY : distanceMeters > radius ? CheckInResult.OUT_OF_GEOFENCE : CheckInResult.VALID;
      if (result === CheckInResult.VALID) {
        void this.notifyCustomerForOrder(
          orderId,
          'Kỹ thuật viên đã đến nơi',
          `Kỹ thuật viên đã có mặt tại điểm hẹn cho đơn hàng #${order.code} và bắt đầu kiểm tra thiết bị.`,
          'TECHNICIAN_ARRIVED',
        );
      }
      const checkIn = { technicianId: actor.id, lat: body.lat, lng: body.lng, accuracyMeters: body.accuracyMeters, distanceMeters, result, checkedInAt: new Date(), deviceInfo: body.deviceInfo || null };
      const saved = await manager.save(ArrivalCheckIn, manager.create(ArrivalCheckIn, { ...checkIn, serviceOrderId: orderId }));
      // Arriving once counts for every device of the visit.
      if (result === CheckInResult.VALID) {
        for (const sibling of await this.visitSiblingOrders(manager, order, actor.id, ServiceOrderStatus.EN_ROUTE)) {
          await manager.save(ArrivalCheckIn, manager.create(ArrivalCheckIn, { ...checkIn, serviceOrderId: sibling.id }));
        }
      }
      return saved;
    });
  }

  /**
   * The other orders of a visit (PO 21/10/2026) this technician holds in `status`:
   * setting out, arriving and the check-in face happen once for the whole visit.
   */
  private async visitSiblingOrders(manager: EntityManager, order: ServiceOrder, technicianId: string, status: ServiceOrderStatus): Promise<ServiceOrder[]> {
    const booking = await manager.findOneBy(Booking, { id: order.bookingId });
    if (!booking?.visitGroupId) return [];
    return manager.createQueryBuilder(ServiceOrder, 'o')
      .innerJoin(Booking, 'b', 'b.id = o.booking_id')
      .innerJoin(TechnicianAssignment, 'a', 'a.service_order_id = o.id AND a.is_active = true AND a.technician_id = :technicianId', { technicianId })
      .where('b.visit_group_id = :groupId AND o.id != :orderId AND o.status = :status', { groupId: booking.visitGroupId, orderId: order.id, status })
      .orderBy('o.id', 'ASC')
      .getMany();
  }

  /**
   * Live GPS ping while EN_ROUTE, for the customer tracking map. Not a geofence check.
   */
  async updateLocation(orderId: string, body: { lat: number; lng: number; accuracyMeters?: number }, actor: { id: string; role: string }): Promise<{ lat: number; lng: number; updatedAt: string }> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (order.status !== ServiceOrderStatus.EN_ROUTE) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Order must be EN_ROUTE');
      if (![body.lat, body.lng].every(Number.isFinite) || Math.abs(body.lat) > 90 || Math.abs(body.lng) > 180) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid GPS coordinates');
      const updatedAt = new Date();
      await manager.update(ServiceOrder, orderId, { technicianLastLat: body.lat, technicianLastLng: body.lng, technicianLocationUpdatedAt: updatedAt });
      return { lat: body.lat, lng: body.lng, updatedAt: updatedAt.toISOString() };
    });
  }


  async startRepair(orderId: string, actor: { id: string; role: string }): Promise<ServiceOrder> {
    // The repair usually starts by itself (autoStartRepair); an older client that
    // still presses "Bắt đầu sửa" afterwards gets the order back unchanged.
    const current = await this.orderRepo.findOneBy({ id: orderId });
    if (current?.status === ServiceOrderStatus.UNDER_REPAIR) {
      // Read-only ownership check: no row lock outside a transaction.
      return authorizeOrder(this.dataSource.manager, orderId, actor, 'technician');
    }
    const res = await this.transitionStatus(orderId, ServiceOrderStatus.UNDER_REPAIR, actor, 'Repair started');
    void this.notifyCustomerForOrder(
      orderId,
      'Kỹ thuật viên đã bắt đầu sửa chữa',
      `Kỹ thuật viên đã có mặt và bắt đầu tiến hành sửa chữa cho đơn hàng #${res.code}.`,
      'REPAIR_STARTED',
    );
    return res;
  }

  /**
   * PO 08/10/2026: there is no separate "start repair" step for the technician.
   * As soon as the order is ready (valid check-in, product photo, and for an
   * inspection job the approved quotation) it moves to UNDER_REPAIR by itself.
   * Not ready yet is not an error: returns false and leaves the order as is.
   */
  async autoStartRepair(orderId: string): Promise<boolean> {
    const order = await this.orderRepo.findOneBy({ id: orderId });
    if (!order || order.status !== ServiceOrderStatus.EN_ROUTE) return false;
    const assignment = await this.dataSource.manager.findOneBy(TechnicianAssignment, { serviceOrderId: orderId, isActive: true });
    if (!assignment) return false;
    try {
      await this.startRepair(orderId, { id: assignment.technicianId, role: Role.TECHNICIAN });
      return true;
    } catch {
      return false;
    }
  }


  async requestCompletion(orderId: string, body: { completionNote?: string }, actor: { id: string; role: string }): Promise<ServiceOrder> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (order.status !== ServiceOrderStatus.UNDER_REPAIR) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Order must be UNDER_REPAIR');
      await this.assertCompletionReady(manager, order);
      if (order.completionRequestedAt) return order;
      await this.generateInvoice(orderId, manager);
      await manager.update(ServiceOrder, orderId, { completionRequestedAt: new Date(), completionNote: body.completionNote?.trim() || null });
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'ORDER_COMPLETION_REQUESTED', resourceType: 'service_order', resourceId: orderId });
      void this.notifyCustomerForOrder(
        orderId,
        'Kỹ thuật viên đã hoàn thành',
        `Kỹ thuật viên đã hoàn thành công việc cho đơn #${order.code} và gửi ảnh sau sửa. Vui lòng thanh toán hoá đơn để hoàn tất đơn.`,
        'COMPLETION_REQUESTED',
      );
      return manager.findOneByOrFail(ServiceOrder, { id: orderId });
    });
  }


  async confirmCompletion(orderId: string, body: { feedback?: string; rating?: number; signatureUrl?: string }, actor: { id: string; role: string }): Promise<{ confirmation: CustomerServiceConfirmation; order: ServiceOrder }> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'customer', true);
      let confirmation = await manager.findOneBy(CustomerServiceConfirmation, { serviceOrderId: orderId });
      if (order.status === ServiceOrderStatus.COMPLETED && confirmation) return { order, confirmation };
      if (order.status !== ServiceOrderStatus.UNDER_REPAIR || !order.completionRequestedAt) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Technician completion request required');
      await this.assertCompletionReady(manager, order);
      if (!confirmation) {
        confirmation = await manager.save(CustomerServiceConfirmation, manager.create(CustomerServiceConfirmation, { serviceOrderId: orderId, customerId: actor.id, confirmedAt: new Date(), feedback: body.feedback || null, rating: body.rating ?? null, signatureUrl: body.signatureUrl || null }));
        await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'CUSTOMER_COMPLETION_CONFIRMED', resourceType: 'service_order', resourceId: orderId });
        if (this.notificationsService) {
          const assignment = await manager.findOneBy(TechnicianAssignment, { serviceOrderId: orderId, isActive: true });
          if (assignment?.technicianId) {
            void this.notificationsService.createNotification({
              userId: assignment.technicianId,
              title: 'Khách hàng đã nghiệm thu công việc!',
              message: `Khách hàng đã xác nhận nghiệm thu dịch vụ cho đơn #${order.code}${body.rating ? ` và đánh giá ${body.rating} sao!` : '.'} Cảm ơn bạn!`,
              type: 'COMPLETION_CONFIRMED',
              referenceId: order.id,
              referenceType: 'SERVICE_ORDER',
            });
          }
        }
      }
      await this.finalizeIfSatisfied(manager, order, actor);
      return { confirmation, order: await manager.findOneByOrFail(ServiceOrder, { id: orderId }) };
    });
  }


  /** Legacy route remains available, but cannot bypass the completion/payment gate. */
  async complete(orderId: string, _body: { completionNote?: string }, actor: { id: string; role: string }): Promise<ServiceOrder> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (order.status === ServiceOrderStatus.COMPLETED) return order;
      if (await isCompletionHeld(manager, order.id)) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Đơn đang được quản lý dịch vụ xem xét khiếu nại nên chưa thể hoàn tất.');
      if (!await this.finalizeIfSatisfied(manager, order, actor)) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Verified payment is required');
      return manager.findOneByOrFail(ServiceOrder, { id: orderId });
    });
  }

  /** Manager re-checks completion after releasing a hold; completes the order only if every gate is met. */
  async retryCompletion(orderId: string, actor: { id: string; role: string }): Promise<{ completed: boolean; order: ServiceOrder }> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'read', true);
      if (order.status === ServiceOrderStatus.COMPLETED) return { completed: true, order };
      if (await isCompletionHeld(manager, order.id)) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Đơn vẫn đang bị giữ hoàn tất bởi một khiếu nại chưa xử lý.');
      const completed = await this.finalizeIfSatisfied(manager, order, actor);
      return { completed, order: await manager.findOneByOrFail(ServiceOrder, { id: orderId }) };
    });
  }


  async cancel(orderId: string, body: { reason: string }, actor: { id: string; role: string }): Promise<ServiceOrder> {
    if (!body.reason?.trim()) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Cancellation reason required');
    const reference = await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.dataSource.transaction(async manager => {
      const booking = await manager.findOneOrFail(Booking, { where: { id: reference.bookingId }, lock: { mode: 'pessimistic_write' } });
      // One device of a visit is not cancelled or dropped alone by the customer or the
      // technician (PO 21/10/2026); staff may still handle one order as an exception.
      if (actor.role === Role.CUSTOMER || actor.role === Role.TECHNICIAN) refuseLoneGroupedBookingAction(booking);
      return this.cancelLocked(manager, booking, orderId, body, actor);
    });
  }

  /**
   * Cancel a whole visit of several devices after its technician accepted
   * (PO 21/10/2026): the customer cancels every order, or the technician, before
   * arriving, drops every order and the visit is matched again through its lead
   * booking. Each order is cancelled by the single-order rules; points are taken
   * and people are told once for the visit, not once per device.
   */
  async cancelVisit(groupId: string, body: { reason: string }, actor: { id: string; role: string }): Promise<ServiceOrder[]> {
    if (!body.reason?.trim()) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Cancellation reason required');
    if (actor.role !== Role.CUSTOMER && actor.role !== Role.TECHNICIAN) throw new ForbiddenException('Order not found or access denied');
    return this.dataSource.transaction(async manager => {
      // The lead booking's row is the visit's lock, taken first like Accept.
      const leadItem = await manager.findOne(VisitGroupItem, { where: { groupId }, order: { sequence: 'ASC' } });
      const lead = leadItem && await manager.findOne(Booking, { where: { id: leadItem.bookingId }, lock: { mode: 'pessimistic_write' } });
      if (!lead) throw new ForbiddenException('Order not found or access denied');
      await manager.findOne(VisitGroup, { where: { id: groupId }, lock: { mode: 'pessimistic_write' } });
      // The lead goes last: its rematch moves the other devices back to matching with it.
      const children = [...await groupSiblings(manager, lead, true), lead];
      const held: Array<{ booking: Booking; order: ServiceOrder }> = [];
      for (const booking of children) {
        const order = await manager.findOneBy(ServiceOrder, { bookingId: booking.id });
        if (order && order.status !== ServiceOrderStatus.CANCELLED) held.push({ booking, order: await authorizeOrder(manager, order.id, actor, actor.role === Role.TECHNICIAN ? 'technician' : 'customer', true) });
      }
      if (!held.length) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Chưa có thợ nhận lượt sửa này.');
      // Refuse before writing anything, so the visit never ends half cancelled.
      for (const { order } of held) {
        if (actor.role === Role.TECHNICIAN && await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: order.id, technicianId: actor.id, result: CheckInResult.VALID })) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'After arrival, request Service Manager exception handling');
        if (actor.role === Role.CUSTOMER && order.status === ServiceOrderStatus.UNDER_REPAIR) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'During repair, request Service Manager exception handling');
      }
      const results: ServiceOrder[] = [];
      for (const [index, { booking, order }] of held.entries()) {
        results.push(await this.cancelLocked(manager, booking, order.id, body, actor, { primary: index === held.length - 1 }));
      }
      if (actor.role === Role.CUSTOMER) await manager.update(VisitGroup, groupId, { status: 'cancelled' });
      return results;
    });
  }

  /**
   * One order's cancellation, the booking row already locked. \`visit.primary\`
   * false marks another device of a visit being cancelled together: its order is
   * closed or dropped the same way, without points, notices or a rematch of its own.
   */
  private async cancelLocked(
    manager: EntityManager, booking: Booking, orderId: string, body: { reason: string }, actor: { id: string; role: string },
    visit?: { primary: boolean },
  ): Promise<ServiceOrder> {
    const secondary = visit?.primary === false;
    const order = await authorizeOrder(manager, orderId, actor, actor.role === Role.TECHNICIAN ? 'technician' : 'read', true);
    if (order.status === ServiceOrderStatus.CANCELLED) return order;
    const arrived = await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: orderId, result: CheckInResult.VALID });
    // A technician has arrived only with their own check-in: after a replacement the earlier
    // technician's check-in stays on the order but says nothing about the new one.
    const selfArrived = actor.role === Role.TECHNICIAN
      ? await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: orderId, technicianId: actor.id, result: CheckInResult.VALID })
      : arrived;
    if (actor.role === Role.TECHNICIAN && selfArrived) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'After arrival, request Service Manager exception handling');
    if (actor.role === Role.CUSTOMER && order.status === ServiceOrderStatus.UNDER_REPAIR) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'During repair, request Service Manager exception handling');
    const from = order.status;
    if (actor.role === Role.TECHNICIAN && !selfArrived && [ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.EN_ROUTE].includes(from)) {
      await manager.update(TechnicianAssignment, { serviceOrderId: orderId, isActive: true }, { isActive: false, unassignedAt: new Date(), unassignReason: body.reason });
      await releaseOutgoingTechnicianPartRequests(manager, orderId, actor.id);
      const withdrawal = await manager.save(Cancellation, manager.create(Cancellation, { serviceOrderId: orderId, actor: CancelActor.TECHNICIAN, actorUserId: actor.id, reason: body.reason, stateAtCancel: from, strikeApplied: false, compensationStatus: CompensationStatus.NOT_ELIGIBLE }));
      if (secondary) {
        // Another device of the visit: the lead booking's rematch below finds the replacement for all.
        await manager.insert(OrderStatusHistory, { serviceOrderId: orderId, fromStatus: from, toStatus: from, actorUserId: actor.id, actorRole: actor.role, reason: 'Kỹ thuật viên rút trước khi tới, đang tìm thợ thay cho cả lượt. Lý do: ' + body.reason });
        await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'TECHNICIAN_WITHDRAWAL_REMATCH', resourceType: 'service_order', resourceId: orderId, after: { reason: body.reason, strikeApplied: false, visitGroupId: booking.visitGroupId } });
        return order;
      }
      await this.reputationService?.penalize(manager, { userId: actor.id, role: Role.TECHNICIAN, reason: `Huỷ nhận đơn #${order.code}: ${body.reason}`, serviceOrderId: orderId, cancellationId: withdrawal.id });
      if (this.notificationsService && booking.customerId) {
        void this.notificationsService.createNotification({
          userId: booking.customerId,
          title: 'Kỹ thuật viên đã huỷ nhận đơn',
          message: `Kỹ thuật viên đã xin rút khỏi đơn #${order.code} (Lý do: "${body.reason}"). Hệ thống đang tự động tìm kiếm thợ thay thế cho bạn.`,
          type: 'ORDER_CANCELLED',
          referenceId: order.id,
          referenceType: 'SERVICE_ORDER',
        });
      }
      const previous = await manager.find(BookingInvitation, { where: { bookingId: booking.id }, order: { priorityOrder: 'ASC' } });
      const last = Math.max(0, ...previous.filter(inv => inv.status === InvitationStatus.ACCEPTED).map(inv => inv.priorityOrder));
      // Append a fresh invitation round; the original dispatch history stays immutable.
      const remaining = previous.filter(inv => inv.priorityOrder > last && inv.status === InvitationStatus.CANCELLED);
      const offset = Math.max(0, ...previous.map(inv => inv.priorityOrder));
      const group = remaining.length > 0
        ? manager.create(BookingInvitationGroup, { id: randomUUID(), bookingId: booking.id })
        : null;
      if (group) await manager.save(group);
      for (const [index, candidate] of remaining.entries()) await manager.save(BookingInvitation, manager.create(BookingInvitation, { groupId: group!.id, bookingId: booking.id, technicianId: candidate.technicianId, priorityOrder: offset + index + 1, status: InvitationStatus.STANDBY, invitedAt: new Date(), expiresAt: null }));
      booking.status = BookingStatus.MATCHING;
      await manager.save(booking);
      await mirrorGroupStatus(manager, booking, BookingStatus.MATCHING);
      await activateNextInvitation(manager, booking, await this.configService.getInt('matching.invitation_ttl_minutes', 30), invitationActivatedHook(this.notificationsService));
      await manager.insert(OrderStatusHistory, { serviceOrderId: orderId, fromStatus: from, toStatus: from, actorUserId: actor.id, actorRole: actor.role, reason: 'Kỹ thuật viên rút trước khi tới, đang tìm thợ thay. Lý do: ' + body.reason });
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'TECHNICIAN_WITHDRAWAL_REMATCH', resourceType: 'service_order', resourceId: orderId, after: { reason: body.reason, strikeApplied: false } });
      return order;
    }
    await this.commitTransition(manager, order, ServiceOrderStatus.CANCELLED, actor, body.reason);
    await closeBookingForCancelledOrder(manager, booking.id);
    const cancellation = await manager.save(Cancellation, manager.create(Cancellation, { serviceOrderId: orderId, actor: actor.role as unknown as CancelActor, actorUserId: actor.id, reason: body.reason, stateAtCancel: from, strikeApplied: false, compensationStatus: CompensationStatus.NOT_ELIGIBLE }));
    // A customer who cancels an order a technician already holds loses points (PO 08/10/2026); staff cancellations cost nobody points.
    // A visit cancelled together costs the points of one cancellation.
    if (actor.role === Role.CUSTOMER && !secondary) await this.reputationService?.penalize(manager, { userId: actor.id, role: Role.CUSTOMER, reason: `Huỷ đơn #${order.code} đã có thợ nhận: ${body.reason}`, serviceOrderId: orderId, cancellationId: cancellation.id });
    await manager.update(TechnicianAssignment, { serviceOrderId: orderId, isActive: true }, { isActive: false, unassignedAt: new Date(), unassignReason: body.reason });
    await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: arrived ? 'CANCELLATION_REQUIRES_REVIEW' : 'ORDER_CANCEL', resourceType: 'service_order', resourceId: orderId, after: { reason: body.reason, strikeApplied: false } });
    if (this.notificationsService && !secondary) {
      const assignment = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: orderId }, order: { assignedAt: 'DESC' } });
      if (assignment?.technicianId && actor.role !== Role.TECHNICIAN) {
        void this.notificationsService.createNotification({
          userId: assignment.technicianId,
          title: 'Đơn hàng đã bị huỷ',
          message: `Đơn hàng #${order.code} đã bị huỷ bởi ${actor.role === Role.CUSTOMER ? 'Khách hàng' : 'Quản trị viên'}. Lý do: "${body.reason}".`,
          type: 'ORDER_CANCELLED',
          referenceId: order.id,
          referenceType: 'SERVICE_ORDER',
        });
      }
      if (booking.customerId && actor.role !== Role.CUSTOMER) {
        void this.notificationsService.createNotification({
          userId: booking.customerId,
          title: 'Đơn hàng đã bị huỷ',
          message: `Đơn hàng #${order.code} đã bị huỷ. Lý do: "${body.reason}".`,
          type: 'ORDER_CANCELLED',
          referenceId: order.id,
          referenceType: 'SERVICE_ORDER',
        });
      }
    }
    return manager.findOneByOrFail(ServiceOrder, { id: orderId });
  }


  /**
   * "Không sửa được" (PO 21/10/2026, G0-2 2A): an approved device of a visit that
   * the technician could not make work. In one step the device ends at 0 đồng
   * (no invoice, no points taken from anyone), the customer is told, and a support
   * case carries the reason and what became of each part received, so a manager
   * checks the parts and settles any dispute. The other devices go on and the
   * visit is paid once without this one. Parts already received stay with their
   * requests for the manager; only what nobody picked up is released.
   */
  async reportRepairFailed(orderId: string, dto: RepairFailedDto, actor: { id: string; role: string }): Promise<ServiceOrder> {
    const reference = await authorizeOrder(this.dataSource.manager, orderId, actor, 'technician');
    let notice: { customerId: string; code: string } | null = null;
    const result = await this.dataSource.transaction(async manager => {
      const booking = await manager.findOneOrFail(Booking, { where: { id: reference.bookingId }, lock: { mode: 'pessimistic_write' } });
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (!booking.visitGroupId) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Chỉ dùng cho thiết bị trong lượt sửa nhiều máy.');
      if (order.status !== ServiceOrderStatus.UNDER_REPAIR || order.completionRequestedAt) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Chỉ báo không sửa được khi đang sửa thiết bị đã duyệt.');
      const received = await manager.find(PartRequest, { where: { serviceOrderId: orderId, technicianId: actor.id, status: PartRequestStatus.RECEIVED }, relations: ['items'] });
      const declared = new Map((dto.parts ?? []).map(part => [part.partRequestId, part.outcome]));
      if (received.some(part => !declared.has(part.id)) || [...declared.keys()].some(id => !received.some(part => part.id === id))) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Chọn Đã lắp hoặc Trả lại kho cho từng linh kiện đã nhận.');
      }
      const label = REPAIR_FAILURE_REASONS[dto.reason];
      const reason = [label, dto.note?.trim()].filter(Boolean).join('. ');
      await this.commitTransition(manager, order, ServiceOrderStatus.CANCELLED, actor, `Không sửa được: ${reason}`);
      await releaseOutgoingTechnicianPartRequests(manager, orderId, actor.id);
      await manager.update(Booking, booking.id, { status: BookingStatus.CANCELLED });
      await recordVisitOutcome(manager, booking, 'failed', reason);
      const partLines = received.map(part => {
        const names = (part.items ?? []).map(item => `${item.partNameSnapshot ?? 'Linh kiện'} x${item.quantity}`).join(', ') || 'Linh kiện';
        return `- ${names}: ${declared.get(part.id) === 'installed' ? 'Đã lắp' : 'Trả lại kho'}`;
      });
      await manager.save(SupportCase, manager.create(SupportCase, {
        caseType: SupportCaseType.MID_JOB_INTERRUPTION,
        status: SupportCaseStatus.OPEN,
        bookingId: booking.id,
        serviceOrderId: orderId,
        customerId: booking.customerId,
        technicianId: actor.id,
        createdByUserId: actor.id,
        reason: `Không sửa được thiết bị đơn #${order.code}`,
        description: [reason, partLines.length ? 'Linh kiện đã nhận:' : 'Không có linh kiện đã nhận.', ...partLines].join('\n'),
        evidenceRefs: [],
        isUrgent: false,
      }));
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'VISIT_DEVICE_REPAIR_FAILED', resourceType: 'service_order', resourceId: orderId, after: { reason: dto.reason, note: dto.note ?? null, parts: dto.parts ?? [], visitGroupId: booking.visitGroupId } });
      if (booking.customerId) notice = { customerId: booking.customerId, code: order.code };
      return manager.findOneByOrFail(ServiceOrder, { id: orderId });
    });
    const told = notice as { customerId: string; code: string } | null;
    if (told && this.notificationsService) {
      await this.notificationsService.createNotification({
        userId: told.customerId,
        title: 'Một thiết bị không sửa được',
        message: `Kỹ thuật viên không sửa được thiết bị của đơn #${told.code}. Thiết bị này không tính tiền sửa; FixHome sẽ liên hệ nếu cần.`,
        type: 'VISIT_DEVICE_REPAIR_FAILED',
        referenceId: result.id,
        referenceType: 'SERVICE_ORDER',
      }).catch(() => undefined);
    }
    return result;
  }

  /** Thợ xem đơn này có được nhả vì đơn trước chưa xong không (PO 20/10/2026). */
  async overrunReleaseStatus(orderId: string, actor: { id: string; role: string }): Promise<OverrunReleaseCheck> {
    const order = await authorizeOrder(this.dataSource.manager, orderId, actor, 'technician');
    const windowMinutes = await this.configService.getInt(OVERRUN_RELEASE_WINDOW_KEY, OVERRUN_RELEASE_WINDOW_DEFAULT_MINUTES);
    return checkOverrunRelease(this.dataSource.manager, order, actor.id, windowMinutes);
  }

  /**
   * Thợ đang ở đơn khác chưa xong nhả đơn kế tiếp: không trừ điểm, không tự mời
   * thợ dự phòng; yêu cầu quay về chờ khách chọn thợ khác với giá và lịch cũ.
   */
  async releaseForOverrun(orderId: string, actor: { id: string; role: string }): Promise<{ order: ServiceOrder; currentOrderCode: string }> {
    const reference = await authorizeOrder(this.dataSource.manager, orderId, actor, 'technician');
    const windowMinutes = await this.configService.getInt(OVERRUN_RELEASE_WINDOW_KEY, OVERRUN_RELEASE_WINDOW_DEFAULT_MINUTES);
    return this.dataSource.transaction(async manager => {
      const booking = await manager.findOneOrFail(Booking, { where: { id: reference.bookingId }, lock: { mode: 'pessimistic_write' } });
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      const check = await checkOverrunRelease(manager, order, actor.id, windowMinutes);
      if (!check.eligible) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Chỉ nhả đơn khi bạn đang làm đơn khác và đơn này sắp tới giờ hẹn.', { block: check.block });
      }
      const reason = `Kỹ thuật viên đang làm đơn #${check.currentOrderCode} chưa xong, không kịp tới buổi hẹn`;
      const from = order.status;
      await manager.update(TechnicianAssignment, { serviceOrderId: orderId, isActive: true }, { isActive: false, unassignedAt: new Date(), unassignReason: reason });
      await releaseOutgoingTechnicianPartRequests(manager, orderId, actor.id);
      await manager.save(Cancellation, manager.create(Cancellation, { serviceOrderId: orderId, actor: CancelActor.TECHNICIAN, actorUserId: actor.id, reason, stateAtCancel: from, strikeApplied: false, compensationStatus: CompensationStatus.NOT_ELIGIBLE }));
      // Khách tự chọn thợ khác: dọn lượt mời còn treo và đóng lượt ghép, để không bị
      // coi là "hết thợ nhận lời mời" (thông báo sai) mà vẫn mở được danh sách mới.
      await manager.update(BookingInvitation, { bookingId: booking.id, status: In([InvitationStatus.PENDING, InvitationStatus.STANDBY]) }, { status: InvitationStatus.CANCELLED, respondedAt: new Date() });
      booking.status = BookingStatus.CLOSED;
      await manager.save(booking);
      await manager.insert(OrderStatusHistory, { serviceOrderId: orderId, fromStatus: from, toStatus: from, actorUserId: actor.id, actorRole: actor.role, reason: reason + '. Khách chọn thợ khác.' });
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'TECHNICIAN_OVERRUN_RELEASE', resourceType: 'service_order', resourceId: orderId, after: { currentOrderCode: check.currentOrderCode, strikeApplied: false } });
      if (this.notificationsService && booking.customerId) {
        void this.notificationsService.createNotification({
          userId: booking.customerId,
          title: 'Thợ không kịp tới buổi hẹn',
          message: `Kỹ thuật viên chưa xong đơn trước nên không sắp xếp kịp thời gian cho yêu cầu #${order.code}. Bạn chọn thợ khác, giá và lịch hẹn giữ nguyên.`,
          type: 'TECHNICIAN_RELEASED',
          referenceId: booking.id,
          referenceType: 'BOOKING',
        });
      }
      return { order: await manager.findOneByOrFail(ServiceOrder, { id: orderId }), currentOrderCode: check.currentOrderCode! };
    });
  }


  async uploadEvidence(orderId: string, body: { type: EvidenceType; note?: string; capturedAt?: string; deferAutoStart?: boolean }, actor: { id: string; role: string }, file?: EvidenceFile): Promise<RepairEvidence> {
    this.evidenceStorage.validate(file);
    if (body.deferAutoStart === true && body.type !== EvidenceType.BEFORE) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'deferAutoStart is only supported for BEFORE evidence');
    if (body.capturedAt && new Date(body.capturedAt) > new Date()) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Evidence timestamp cannot be in the future');
    // Check-in face and the before photo belong to the arrival (EN_ROUTE); the rest to the repair.
    const atArrival = body.type === EvidenceType.BEFORE || body.type === EvidenceType.CHECKIN_FACE;
    const expected = atArrival ? ServiceOrderStatus.EN_ROUTE : ServiceOrderStatus.UNDER_REPAIR;
    const max = await this.configService.getInt('evidence.max_count_per_type', 20);
    const checkEligible = async (manager: EntityManager): Promise<void> => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (order.status !== expected || order.completionRequestedAt) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Evidence timing is invalid');
      if (atArrival && !await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: orderId, technicianId: actor.id, result: CheckInResult.VALID })) throw new BusinessException(ErrorCodes.CHECKIN_OUT_OF_GEOFENCE, 'Valid arrival required before BEFORE evidence');
      // PO 11/10/2026: check-in is the GPS fix plus the technician's face; the product photo comes after.
      if (body.type === EvidenceType.BEFORE && !await manager.findOneBy(RepairEvidence, { serviceOrderId: orderId, uploaderId: actor.id, type: EvidenceType.CHECKIN_FACE })) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Chụp ảnh khuôn mặt check-in trước khi chụp ảnh máy');
      }
      const count = await manager.count(RepairEvidence, { where: { serviceOrderId: orderId, type: body.type } });
      if (count >= max) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Evidence limit exceeded');
    };
    // Pre-check under the row lock, released immediately — the Cloudinary round-trip below
    // must never run while the ServiceOrder row lock is held, or every other read/write on
    // the same order blocks for as long as the upload takes (observed: 30s+ GETs).
    await this.dataSource.transaction(manager => checkEligible(manager));
    const stampedOrder = await this.orderRepo.findOneBy({ id: orderId });
    const capturedAt = body.capturedAt ? new Date(body.capturedAt) : new Date();
    const mediaUrl = await this.evidenceStorage.upload(orderId, actor.id, file, stampedOrder ? evidenceStampText(capturedAt, stampedOrder.code) : undefined);
    try {
      const saved = await this.dataSource.transaction(async manager => {
        await checkEligible(manager); // re-validate: state may have changed during the upload
        const evidence = { uploaderId: actor.id, type: body.type, mediaUrl, mimeType: file.mimetype, fileSize: file.size, note: body.note || null, capturedAt };
        const row = await manager.save(RepairEvidence, manager.create(RepairEvidence, { ...evidence, serviceOrderId: orderId }));
        // The check-in face is shown once for a visit; each device still gets its own photos.
        if (body.type === EvidenceType.CHECKIN_FACE) {
          const order = await manager.findOneByOrFail(ServiceOrder, { id: orderId });
          for (const sibling of await this.visitSiblingOrders(manager, order, actor.id, ServiceOrderStatus.EN_ROUTE)) {
            await manager.save(RepairEvidence, manager.create(RepairEvidence, { ...evidence, serviceOrderId: sibling.id }));
          }
        }
        return row;
      });
      // Check-in with the product photo is the last step before repair for a
      // fixed-price job; an inspection job also needs the approved quotation.
      // A camera batch defers this attempt on earlier photos, then omits the
      // flag on its final upload. All evidence and transition gates stay intact.
      if (body.type === EvidenceType.BEFORE && body.deferAutoStart !== true) await this.autoStartRepair(orderId);
      return saved;
    } catch (error) {
      await this.evidenceStorage.delete(mediaUrl); // avoid an orphaned upload when the re-check rejects it
      throw error;
    }
  }


  async getEvidence(
    orderId: string,
    actor: { id: string; role: string },
  ): Promise<RepairEvidence[]> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    const evidence = await this.evidenceRepo.find({ where: { serviceOrderId: orderId }, order: { createdAt: 'ASC' } });
    return Promise.all(evidence.map(async item => ({ ...item, mediaUrl: await this.evidenceStorage.signedUrl(item.mediaUrl) })));
  }

  async deleteEvidence(
    orderId: string,
    evidenceId: string,
    actor: { id: string; role: string },
  ): Promise<void> {
    // BRX-037: evidence that let the order move on stays. Only the technician
    // holding the order deletes, under the order lock, and every deletion is audited.
    const evidence = await this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      const found = await manager.findOne(RepairEvidence, { where: { id: evidenceId, serviceOrderId: orderId } });
      if (!found) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Evidence not found');
      if (order.completionRequestedAt || [ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED].includes(order.status)) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Cannot delete evidence after completion requested');
      }
      if (found.type === EvidenceType.CHECKIN_FACE) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Ảnh khuôn mặt check-in không xoá được');
      }
      if (found.type === EvidenceType.BEFORE && order.status !== ServiceOrderStatus.EN_ROUTE) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Ảnh trước khi sửa đã dùng để bắt đầu sửa, không xoá được');
      }
      await manager.delete(RepairEvidence, { id: evidenceId, serviceOrderId: orderId });
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'EVIDENCE_DELETE', resourceType: 'service_order', resourceId: orderId, before: { evidenceId, type: found.type, mediaUrl: found.mediaUrl } });
      return found;
    });
    try {
      await this.evidenceStorage.delete(evidence.mediaUrl);
    } catch {
      // Non-blocking
    }
  }

  /**
   * Get status history for an order (D-22 audit trail).
   */
  async getStatusHistory(orderId: string, actor: { id: string; role: string }): Promise<OrderStatusHistory[]> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.historyRepo.find({
      where: { serviceOrderId: orderId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Finance delegates keep the existing Service Orders public surface while
   * keeping money-state authority in the Finance module.
   */
  async getInvoice(
    orderId: string,
    actor: FinanceActor,
  ): Promise<InvoiceResponseDto | null> {
    return this.financeService.getInvoice(orderId, actor);
  }

  async payInvoice(
    invoiceId: string,
    actor: FinanceActor,
    dto: InitiatePaymentDto,
  ): Promise<PaymentResponseDto> {
    return this.financeService.initiateInvoicePayment(invoiceId, actor, dto);
  }

  async createInvoiceVnpayUrl(
    invoiceId: string,
    actor: FinanceActor,
    ipAddr: string,
    platform: 'web' | 'mobile' = 'web',
    webOrigin?: string,
  ): Promise<{ paymentUrl: string }> {
    return this.financeService.createVnpayPaymentUrl(invoiceId, actor, ipAddr, platform, webOrigin);
  }


  /**
   * Each coverage says what it covers: the labor or the part on the invoice line it came
   * from, so a customer can tell which item to claim.
   */
  async getWarranties(orderId: string, actor: { id: string; role: string }): Promise<WarrantyCoverageView[]> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    const coverages = await this.warrantyRepo.find({
      where: { serviceOrderId: orderId },
      order: { expiresAt: 'ASC' },
    });
    const itemIds = coverages.map(c => c.invoiceItemId).filter((id): id is string => !!id);
    const items = itemIds.length ? await this.dataSource.manager.findBy(InvoiceItem, { id: In(itemIds) }) : [];
    const byId = new Map(items.map(item => [item.id, item]));
    return coverages.map(coverage => {
      const item = coverage.invoiceItemId ? byId.get(coverage.invoiceItemId) : undefined;
      return { ...coverage, itemType: item?.type ?? null, itemDescription: item?.description ?? null };
    });
  }

  // ── Spec v1.2: Cash Settlement & Commission Tracking ──

  async declareCashSettlement(
    orderId: string,
    dto: CashSettlementDeclarationDto,
    actor: FinanceActor,
  ): Promise<CashSettlementResponseDto> {
    return this.financeService.declareCashSettlement(orderId, dto, actor);
  }

  async confirmCashSettlement(
    orderId: string,
    dto: CashSettlementConfirmationDto,
    actor: FinanceActor,
  ): Promise<CashSettlementResponseDto> {
    return this.financeService.confirmCashSettlement(orderId, dto, actor);
  }

  async getCashSettlement(
    orderId: string,
    actor: FinanceActor,
  ): Promise<CashSettlementResponseDto | null> {
    return this.financeService.getCashSettlement(orderId, actor);
  }

  async getCommissionDues(
    actor: FinanceActor,
  ): Promise<{ data: CommissionDueResponseDto[]; totalDue: number }> {
    return this.financeService.getCommissionDues(actor);
  }

  async payCommissionDue(
    dueId: string,
    actor: FinanceActor,
    dto: InitiatePaymentDto,
  ): Promise<PaymentResponseDto> {
    return this.financeService.initiateCommissionDuePayment(dueId, actor, dto);
  }


  /**
   * Get cancellations for SM/Admin board.
   */
  async getCancellations(options: {
    page?: number;
    limit?: number;
  }): Promise<{ data: CancellationListItem[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const [rows, total] = await this.cancellationRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const [people, codes, points] = await Promise.all([
      this.namesOf(rows.map((row) => row.actorUserId)),
      this.orderCodesOf(rows.map((row) => row.serviceOrderId)),
      this.reputationCostOf(rows.map((row) => row.id)),
    ]);
    const data = rows.map((row) => ({
      ...row,
      actorName: people.get(row.actorUserId)?.fullName ?? null,
      actorRole: people.get(row.actorUserId)?.role ?? null,
      orderCode: codes.get(row.serviceOrderId) ?? null,
      reputationDelta: points.get(row.id) ?? null,
    }));
    return { data, total };
  }

  /**
   * Who and which order, for the review lists. Service Managers review these
   * lists but may not read user records (that is Admin's), so the list carries
   * the name and role it shows instead of the page asking per row.
   */
  private async namesOf(userIds: string[]): Promise<Map<string, { fullName: string | null; role: string; bookingSuspendedUntil: Date | null }>> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const users = await this.dataSource.getRepository(User).find({
      where: { id: In(ids) },
      select: { id: true, fullName: true, role: true, bookingSuspendedUntil: true },
    });
    return new Map(users.map((user) => [user.id, {
      fullName: user.fullName ?? null,
      role: String(user.role),
      bookingSuspendedUntil: user.bookingSuspendedUntil ?? null,
    }]));
  }

  /** Points each cancellation cost, from the reputation history. */
  private async reputationCostOf(cancellationIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(cancellationIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const rows: Array<{ cancellation_id: string; delta: string }> = await this.dataSource.query(
      `SELECT "cancellation_id", SUM("delta") AS delta FROM "reputation_events" WHERE "kind" = 'violation' AND "cancellation_id" = ANY($1) GROUP BY "cancellation_id"`,
      [ids],
    );
    return new Map(rows.map((row) => [row.cancellation_id, Number(row.delta)]));
  }

  private async orderCodesOf(orderIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(orderIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const orders = await this.dataSource.getRepository(ServiceOrder).find({
      where: { id: In(ids) },
      select: { id: true, code: true },
    });
    return new Map(orders.map((order) => [order.id, order.code]));
  }

  /**
   * Review cancellation — waive strike, decide compensation.
   */
  async reviewCancellation(
    cancellationId: string,
    body: {
      confirmViolation?: boolean;
      waiveStrike?: boolean;
      waiveReason?: string;
      compensationDecision?: 'GRANTED' | 'REJECTED';
      grantPriorityBoost?: boolean;
    },
    actor: { id: string; role: string },
  ): Promise<Cancellation> {
    if (![Role.ADMIN, Role.SERVICE_MANAGER].includes(actor.role as Role)) throw new ForbiddenException('Staff review required');
    if (body.compensationDecision === 'GRANTED') throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Monetary cancellation compensation is not supported by MASTER v1.4');
    // PO 09/10/2026: cancelling costs reputation points by itself; staff no longer confirm violations by hand.
    if (body.confirmViolation) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Huỷ đơn đã tự trừ điểm uy tín, không còn xác nhận vi phạm thủ công. Điều chỉnh điểm ở trang Điểm uy tín.');
    // Checked before anything is written: the reason is what the audit and the user see later.
    if (body.waiveStrike && !body.waiveReason?.trim()) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Cần ghi lý do miễn vi phạm');
    const cancellation = await this.cancellationRepo.findOneBy({
      id: cancellationId,
    });
    if (!cancellation) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Cancellation not found');
    }

    cancellation.reviewedByUserId = actor.id;

    if (body.compensationDecision) {
      cancellation.compensationStatus = CompensationStatus.REJECTED;
    }

    // Spec v1.2: Grant Priority Boost to technician if requested
    if (body.grantPriorityBoost) {
      const assignment = await this.assignmentRepo.findOne({
        where: { serviceOrderId: cancellation.serviceOrderId },
        order: { createdAt: 'DESC' },
      });
      if (assignment) {
        const boostDays = await this.configService.getInt('priority_boost.duration_days', 7);
        const boostUntil = new Date(Date.now() + boostDays * 24 * 60 * 60 * 1000);
        await this.techProfileRepo.update(
          { userId: assignment.technicianId },
          { priorityBoostUntil: boostUntil },
        );
      }
    }

    if (body.waiveStrike && cancellation.strikeApplied) {
      const strike = await this.strikeRepo.findOne({
        where: { cancellationId: cancellation.id, status: StrikeStatus.ACTIVE },
      });
      if (strike) {
        strike.status = StrikeStatus.WAIVED;
        strike.waivedByUserId = actor.id;
        strike.waiveReason = body.waiveReason!.trim();
        await this.strikeRepo.save(strike);
      }
    }

    const saved = await this.cancellationRepo.save(cancellation);

    await this.auditLogService.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'CANCELLATION_REVIEW',
      resourceType: 'cancellation',
      resourceId: cancellationId,
      after: body,
    });

    return saved;
  }

  /**
   * Get strikes for a user.
   */
  async getStrikes(options: {
    userId?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: StrikeListItem[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.strikeRepo.createQueryBuilder('s');
    if (options.userId) {
      qb.where('s.userId = :userId', { userId: options.userId });
    }

    qb.orderBy('s.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const cancellations = rows.length
      ? await this.cancellationRepo.find({
          where: { id: In([...new Set(rows.map((row) => row.cancellationId))]) },
          select: { id: true, serviceOrderId: true },
        })
      : [];
    const orderOf = new Map(cancellations.map((c) => [c.id, c.serviceOrderId]));
    const [people, codes] = await Promise.all([
      this.namesOf(rows.map((row) => row.userId)),
      this.orderCodesOf(cancellations.map((c) => c.serviceOrderId)),
    ]);
    const data = rows.map((row) => {
      const orderId = orderOf.get(row.cancellationId);
      return {
        ...row,
        userName: people.get(row.userId)?.fullName ?? null,
        userRole: people.get(row.userId)?.role ?? null,
        userSuspendedUntil: people.get(row.userId)?.bookingSuspendedUntil ?? null,
        serviceOrderId: orderId ?? null,
        orderCode: orderId ? codes.get(orderId) ?? null : null,
      };
    });
    return { data, total };
  }

  /**
   * Waive a strike.
   */
  async waiveStrike(
    strikeId: string,
    body: { reason: string },
    actor: { id: string; role: string },
  ): Promise<CancellationStrike> {
    const strike = await this.strikeRepo.findOneBy({ id: strikeId });
    if (!strike) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Strike not found');
    }

    strike.status = StrikeStatus.WAIVED;
    strike.waivedByUserId = actor.id;
    strike.waiveReason = body.reason;

    const saved = await this.strikeRepo.save(strike);

    await this.auditLogService.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'STRIKE_WAIVE',
      resourceType: 'cancellation_strike',
      resourceId: strikeId,
      after: { reason: body.reason },
    });

    return saved;
  }

  /**
   * D-20: Repair history — read model derived from service_orders + invoices + reviews.
   * NO separate table.
   */
  async getRepairHistory(
    userId: string,
    role: string,
    options: { page?: number; limit?: number; status?: ServiceOrderStatus; search?: string },
  ): Promise<{ data: Record<string, unknown>[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.orderRepo
      .createQueryBuilder('o')
      .leftJoinAndSelect('bookings', 'b', 'b.id = o.booking_id')
      .leftJoinAndSelect('services', 's', 's.id = b.service_id')
      .where('o.status IN (:...terminal)', { terminal: repairHistoryStatuses(options.status) });

    if (role === Role.CUSTOMER) {
      qb.andWhere('b.customer_id = :userId', { userId });
    } else if (role === Role.TECHNICIAN) {
      qb.innerJoin(
        'technician_assignments',
        'ta',
        'ta.service_order_id = o.id',
      ).andWhere('ta.technician_id = :userId', { userId })
        // The last assignment is the technician who held the order at the end.
        .andWhere('ta.assigned_at = (SELECT MAX(x.assigned_at) FROM technician_assignments x WHERE x.service_order_id = o.id)');
    }
    andWhereTextMatches(qb, ['o.code', 'b.service_name_snapshot'], options.search);

    qb.orderBy('o.completedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();

    // Return as plain objects matching the read model
    const result = await Promise.all(data.map(async order => {
      const booking = await this.dataSource.manager.findOneBy(Booking, { id: order.bookingId });
      const assignment = await this.assignmentRepo.findOne({ where: { serviceOrderId: order.id }, order: { assignedAt: 'DESC' } });
      const technician = assignment ? await this.userRepo.findOneBy({ id: assignment.technicianId }) : null;
      return {
        orderId: order.id, bookingId: order.bookingId, code: order.code, status: order.status,
        serviceName: booking?.serviceNameSnapshot, technicianName: technician?.fullName,
        addressSummary: booking?.addressTextSnapshot,
        laborTotal: Number(order.laborTotal), partsTotal: Number(order.partsTotal), grandTotal: Number(order.grandTotal),
        completedAt: order.completedAt, cancelledAt: order.cancelledAt,
      };
    }));

    return { data: result, total };
  }

  // ── Private helpers ──

  /**
   * D-22: Central method for state transitions within a transaction.
   */
  private async transitionStatus(orderId: string, nextStatus: ServiceOrderStatus, actor: { id: string; role: string }, reason?: string): Promise<ServiceOrder> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (nextStatus === ServiceOrderStatus.UNDER_REPAIR) {
        const booking = await manager.findOneByOrFail(Booking, { id: order.bookingId });
        if (!await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: orderId, technicianId: actor.id, result: CheckInResult.VALID })) throw new BusinessException(ErrorCodes.CHECKIN_OUT_OF_GEOFENCE, 'Valid arrival required');
        const required = await this.configService.getInt('evidence.before.min_count', 1);
        if (await manager.count(RepairEvidence, { where: { serviceOrderId: orderId, type: EvidenceType.BEFORE, uploaderId: actor.id } }) < required) throw new BusinessException(ErrorCodes.EVIDENCE_REQUIRED_BEFORE, 'BEFORE evidence required');
        // A device of a visit is quoted on site even at a fixed price (PO 21/10/2026, G0-1 1B).
        if ((booking.pricingModeSnapshot !== ServicePricingMode.FIXED_PRICE || booking.visitGroupId) && !await manager.findOneBy(Quotation, { serviceOrderId: orderId, technicianId: actor.id, status: QuotationStatus.APPROVED })) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Approved official quotation required');
        if (booking.pricingModeSnapshot === ServicePricingMode.FIXED_PRICE && booking.fixedUnitPriceSnapshot == null) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Fixed price snapshot missing');
        if (await manager.count(AdditionalCostRequest, { where: { serviceOrderId: orderId, status: AdditionalCostStatus.PENDING_APPROVAL } })) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Additional approval required');
      }
      await this.commitTransition(manager, order, nextStatus, actor, reason || 'Order progress');
      return manager.findOneByOrFail(ServiceOrder, { id: orderId });
    });
  }

  private async commitTransition(manager: EntityManager, order: ServiceOrder, next: ServiceOrderStatus, actor: { id: string | null; role: string }, reason: string): Promise<void> {
    if (!ServiceOrderStateMachine.canTransition(order.status, next)) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Illegal order transition');
    const previous = order.status;
    const now = new Date();
    await manager.update(ServiceOrder, order.id, { status: next, ...(next === ServiceOrderStatus.UNDER_REPAIR ? { startedAt: now } : {}), ...(next === ServiceOrderStatus.COMPLETED ? { completedAt: now } : {}), ...(next === ServiceOrderStatus.CANCELLED ? { cancelledAt: now } : {}) });
    await manager.insert(OrderStatusHistory, { serviceOrderId: order.id, fromStatus: previous, toStatus: next, actorUserId: actor.id, actorRole: actor.role, reason });
    await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'ORDER_TRANSITION', resourceType: 'service_order', resourceId: order.id, before: { status: previous }, after: { status: next, reason } });
    if ([ServiceOrderStatus.CANCELLED, ServiceOrderStatus.COMPLETED].includes(next)) await closeOrderPartRequests(manager, order.id, next === ServiceOrderStatus.CANCELLED);
    if (next === ServiceOrderStatus.CANCELLED) {
      // #27: nothing is paid on a cancelled order; open attempts on its invoice are closed.
      await manager.createQueryBuilder().update(Payment)
        .set({ status: PaymentAttemptStatus.CANCELLED, failureCode: 'ORDER_CANCELLED' })
        .where('status = :pending AND invoice_id IN (SELECT id FROM invoices WHERE service_order_id = :orderId)', { pending: PaymentAttemptStatus.PENDING, orderId: order.id })
        .execute();
    }
    order.status = next;
  }

  private async assertCompletionReady(manager: EntityManager, order: ServiceOrder): Promise<void> {
    assertPartsResolved(await holderPartRequests(manager, order.id));
    await expireAdditionalCosts(manager, order.id);
    const required = await this.configService.getInt('evidence.after.min_count', 1);
    if (await manager.count(RepairEvidence, { where: { serviceOrderId: order.id, type: EvidenceType.AFTER } }) < required) throw new BusinessException(ErrorCodes.EVIDENCE_REQUIRED_AFTER, 'AFTER evidence required');
    if (await manager.count(AdditionalCostRequest, { where: { serviceOrderId: order.id, status: AdditionalCostStatus.PENDING_APPROVAL } }) || await manager.count(Quotation, { where: { serviceOrderId: order.id, status: QuotationStatus.SENT } })) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Pending financial approval');
    const booking = await manager.findOneByOrFail(Booking, { id: order.bookingId });
    if (booking.pricingModeSnapshot !== ServicePricingMode.FIXED_PRICE && !await manager.findOneBy(Quotation, { serviceOrderId: order.id, status: QuotationStatus.APPROVED })) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Approved quotation required');
  }

  private async finalizeIfSatisfied(manager: EntityManager, order: ServiceOrder, actor: { id: string | null; role: string }): Promise<boolean> {
    if (order.status !== ServiceOrderStatus.UNDER_REPAIR || !order.completionRequestedAt) return false;
    if (await isCompletionHeld(manager, order.id)) return false;
    await this.assertCompletionReady(manager, order);
    // No customer acceptance step (PO 09/10/2026): the technician's completion with the after photo is the
    // acceptance; what is left is the payment.
    const invoice = await manager.findOneBy(Invoice, { serviceOrderId: order.id, paymentStatus: PaymentStatus.PAID });
    if (!invoice || order.paymentStatus !== PaymentStatus.PAID) return false;
    await this.commitTransition(manager, order, ServiceOrderStatus.COMPLETED, actor, 'Work completed by the technician and payment verified');
    await applyOrderCompletionEffects(manager, order, invoice.id, new Date());
    if (this.settlementService) {
      await this.settlementService.trySettleOrder(order.id, manager);
    }
    return true;
  }


  private async generateInvoice(
    orderId: string,
    manager: EntityManager,
  ): Promise<Invoice> {
    const existing = await manager.findOneBy(Invoice, { serviceOrderId: orderId });
    if (existing) return existing;
    const order = await manager.findOne(ServiceOrder, { where: { id: orderId } });

    const booking = order
      ? await manager.findOne(Booking, {
          where: { id: order.bookingId },
          relations: ['service'],
        })
      : null;

    // Get approved quotation (if any)
    const quotation = await manager.findOne(Quotation, {
      where: { serviceOrderId: orderId, status: QuotationStatus.APPROVED },
      relations: ['items'],
    });

    // Get approved additional costs
    const additionalCosts = await manager.find(AdditionalCostRequest, {
      where: {
        serviceOrderId: orderId,
        status: AdditionalCostStatus.APPROVED,
      },
    });
    const additionalCostIds = additionalCosts.map((ac) => ac.id);
    let additionalItems: AdditionalCostItem[] = [];
    if (additionalCostIds.length > 0) {
      additionalItems = await manager
        .createQueryBuilder(AdditionalCostItem, 'aci')
        .where('aci.request_id IN (:...ids)', { ids: additionalCostIds })
        .getMany();
    }

    const requests = await manager.find(PartRequest, { where: { serviceOrderId: orderId }, relations: ['items'] });
    const heldRequests = await holderPartRequests(manager, orderId, requests);
    assertPartsResolved(heldRequests);
    const custodyUsage = await custodyUsageForInvoice(manager, orderId);
    assertApprovedPartsResolved([
      ...(quotation?.items ?? []).map(item => ({ ...item, source: 'quotation' })),
      ...additionalItems.map(item => ({ ...item, source: item.requestId })),
    ], heldRequests, quotation?.id ?? null, custodyUsage);
    const billableQuantity = usedPartQuantities(heldRequests, custodyUsage, quotation?.id ?? null);

    // Calculate totals
    let laborTotal = 0;
    let fixHomePartsTotal = 0;
    let technicianPartsTotal = 0;
    let technicianPartWarrantyFeeTotal = 0;

    const invoiceItems: Partial<InvoiceItem>[] = [];

    // 1. Check if FIXED_PRICE booking
    const isFixedPrice =
      booking?.pricingModeSnapshot === ServicePricingMode.FIXED_PRICE ||
      (!quotation && booking?.fixedUnitPriceSnapshot != null);

    if (isFixedPrice && booking) {
      const unitPrice = Number(booking.fixedUnitPriceSnapshot);
      const quantity = Math.max(1, Number(booking.quantity || 1));
      const lineTotal = unitPrice * quantity;
      laborTotal += lineTotal;

      invoiceItems.push({
        sourceType: 'FIXED_PRICE',
        sourceItemId: booking.id,
        type: CostItemType.LABOR,
        description:
          booking.scopeSnapshot ||
          booking.service?.name ||
          'Fixed Price Labor Package',
        quantity,
        unitPrice,
        lineTotal,
        // Fixed when the technician was assigned (PO 10/10/2026); orders from before then had none.
        warrantyDaysSnapshot: order?.laborWarrantyDays ?? 0,
      });
    }

    if (!isFixedPrice && quotation?.items) {
      // 2. Inspection-based quotation items
      for (const qi of quotation.items) {
        const quantity = billableQuantity('quotation', qi);
        if (!quantity) continue;
        const lineTotal = quantity * Number(qi.unitPrice);
        if (qi.type === CostItemType.LABOR) {
          laborTotal += lineTotal;
        } else {
          if (qi.partSource === PartSource.FIXHOME) {
            fixHomePartsTotal += lineTotal;
          } else {
            technicianPartsTotal += lineTotal;
          }
          if (qi.warrantyFee) {
            technicianPartWarrantyFeeTotal += Number(qi.warrantyFee);
          }
        }

        invoiceItems.push({
          sourceType: 'QUOTATION',
          sourceItemId: qi.id,
          type: qi.type,
          description: qi.description,
          quantity,
          unitPrice: Number(qi.unitPrice),
          lineTotal,
          warrantyDaysSnapshot: qi.partSource === PartSource.TECHNICIAN ? (qi.partWarrantyOption === PartWarrantyOption.PAID_WARRANTY ? qi.warrantyTermDays ?? 0 : 0) : qi.warrantyDaysSnapshot,
          partSource: qi.partSource || null,
          partWarrantyOption: qi.partWarrantyOption || null,
          warrantyFee: qi.warrantyFee || null,
        });
      }
    }

    // 3. Approved Additional cost items
    for (const aci of additionalItems) {
      const quantity = billableQuantity(aci.requestId, aci);
      if (!quantity) continue;
      const lineTotal = quantity * Number(aci.unitPrice);
      if (aci.type === CostItemType.LABOR) {
        laborTotal += lineTotal;
      } else {
        if (aci.partSource === PartSource.FIXHOME) {
          fixHomePartsTotal += lineTotal;
        } else {
          technicianPartsTotal += lineTotal;
        }
        if (aci.warrantyFee) {
          technicianPartWarrantyFeeTotal += Number(aci.warrantyFee);
        }
      }

      invoiceItems.push({
        sourceType: 'ADDITIONAL',
        sourceItemId: aci.id,
        type: aci.type,
        description: aci.description,
        quantity,
        unitPrice: Number(aci.unitPrice),
        lineTotal,
        warrantyDaysSnapshot: aci.partSource === PartSource.TECHNICIAN ? (aci.partWarrantyOption === PartWarrantyOption.PAID_WARRANTY ? aci.warrantyTermDays ?? 0 : 0) : aci.warrantyDays,
        partSource: aci.partSource || null,
        partWarrantyOption: aci.partWarrantyOption || null,
        warrantyFee: aci.warrantyFee || null,
      });
    }

    const partsTotal = fixHomePartsTotal + technicianPartsTotal;
    const shippingFee = additionalCosts.reduce((sum, cost) => sum + (
      requests.some(r => r.additionalCostId === cost.id && r.receivedAt && r.fulfillmentMethod === 'delivery' && ['received', 'completed'].includes(r.status))
        ? Number(cost.shippingFee || 0) : 0), 0);
    const grandTotal = laborTotal + partsTotal + technicianPartWarrantyFeeTotal + shippingFee;

    // Spec v1.4 BRX-026: Platform commission is 10% on Final Labor Total. 0% on parts. Rate snapshotted.
    const commissionBase = 'LABOR';
    const commissionRateSnapshot = (await this.configService.getInt('commission.rate_bps', 1000)) / 10000;
    if (commissionRateSnapshot < 0 || commissionRateSnapshot > 1) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid commission configuration');
    const commissionAmount = Math.round(laborTotal * commissionRateSnapshot);

    // Create invoice
    const invoice = manager.create(Invoice, {
      serviceOrderId: orderId,
      laborTotal,
      partsTotal,
      fixHomePartsTotal,
      technicianPartsTotal,
      technicianPartWarrantyFeeTotal,
      shippingFee,
      grandTotal,
      commissionBase,
      commissionRateSnapshot,
      commissionAmount,
      paymentStatus: PaymentStatus.UNPAID,
      issuedAt: new Date(),
    });
    const savedInvoice = await manager.save(Invoice, invoice);

    // Create invoice items
    for (const item of invoiceItems) {
      item.invoiceId = savedInvoice.id;
      await manager.insert(InvoiceItem, item);

    }

    // Update order totals
    await manager.update(ServiceOrder, orderId, {
      laborTotal,
      partsTotal,
      grandTotal,
    });

    return savedInvoice;
  }

  /**
   * Check if an actor has access to a specific order.
   */
  private async checkOrderAccess(order: ServiceOrder, actor: { id: string; role: string }): Promise<void> {
    await authorizeOrder(this.dataSource.manager, order.id, actor);
  }


}
