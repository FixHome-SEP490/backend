import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, In, IsNull, LessThan, Not } from 'typeorm';
import { startBackgroundJob } from '../../common/background-job';
import {
  PartRequestStatus,
  PartRequestType,
  WARRANTY_CLAIM_ACTIVE_STATUSES,
  WarrantyClaimStatus,
  WarrantyCustomerPrompt,
  WarrantyStatus,
  WarrantyVisitStatus,
} from '../../shared/enums';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { PartRequestsService } from '../part-requests/part-requests.service';
import { BusinessConfigService } from '../system-config/business-config.service';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { WarrantyVisit } from './entities/warranty-visit.entity';
import { WarrantyCostService } from './warranty-cost.service';
import { WarrantyNotifier } from './warranty-notifier.service';

const BATCH = 20;
const HOUR_MS = 3_600_000;

/**
 * Deadlines of the warranty flow (PO 04/11/2026): a technician who does not answer or show is
 * handed to a manager, a silent customer closes the claim, and coverage past its date is marked
 * expired. Nothing here costs reputation by itself: a manager confirms first.
 */
@Injectable()
export class WarrantySweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WarrantySweepService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: BusinessConfigService,
    private readonly notifier: WarrantyNotifier,
    private readonly partRequests: PartRequestsService,
    private readonly cost: WarrantyCostService,
  ) {}

  onModuleInit(): void {
    this.timer = startBackgroundJob('warranty sweep', this.logger, async () => { await this.sweep(); });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One step failing never stops the others. */
  async sweep(now = new Date()): Promise<void> {
    const steps: Array<[string, (at: Date) => Promise<void>]> = [
      ['unresponded', (at) => this.sweepUnresponded(at)],
      ['unassigned', (at) => this.sweepUnassigned(at)],
      ['no-show', (at) => this.sweepNoShow(at)],
      ['customer silent', (at) => this.sweepCustomerSilent(at)],
      ['expired coverage', (at) => this.sweepExpiredCoverage(at)],
      ['faulty part return', (at) => this.sweepFaultyReturn(at)],
    ];
    for (const [name, step] of steps) {
      try { await step(now); } catch (error) {
        this.logger.warn(`warranty sweep ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private hours(key: string, fallback: number): Promise<number> {
    return this.config.getInt(key, fallback);
  }

  /** Accepted nothing within the window: take the claim back and let a manager reassign and judge. */
  async sweepUnresponded(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - (await this.hours('warranty.tech_response_hours', 48)) * HOUR_MS);
    const due = await this.dataSource.getRepository(WarrantyClaim).find({
      where: { status: WarrantyClaimStatus.SUBMITTED, technicianId: Not(IsNull()), updatedAt: LessThan(cutoff) },
      take: BATCH,
    });
    for (const { id } of due) {
      const taken = await this.dataSource.transaction(async (tx) => {
        const claim = await tx.findOne(WarrantyClaim, { where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!claim || claim.status !== WarrantyClaimStatus.SUBMITTED || !claim.technicianId || claim.updatedAt >= cutoff) return null;
        await tx.update(WarrantyClaim, claim.id, {
          technicianId: null, declinedByTechnicianId: claim.technicianId, declineReasonCode: 'no_response',
          declinedAt: now, declineReview: 'pending', lastReminderAt: null,
        });
        return claim;
      });
      if (taken) {
        await this.notifier.toManagers(
          'Kỹ thuật viên chưa phản hồi bảo hành',
          'Kỹ thuật viên không nhận yêu cầu bảo hành đúng hạn. Vui lòng phân công lại và xem xét trách nhiệm.',
          'WARRANTY_REASSIGN_NEEDED', taken.serviceOrderId,
        );
      }
    }
  }

  /**
   * The faulty part is due back a few days after the replacement was received (PO 05/11/2026): remind the
   * technician once before the deadline, and charge the new part's price once after it. The charge is
   * given back if the manager later finds the fault was not the installation.
   */
  async sweepFaultyReturn(now: Date): Promise<void> {
    const reminderHours = await this.hours('warranty.faulty_return_reminder_hours', 24);
    const open = await this.dataSource.getRepository(PartRequest).find({
      where: {
        requestType: PartRequestType.WARRANTY, status: In([PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED]),
        faultyReturnedAt: IsNull(), faultyReturnChargedAt: IsNull(), faultyReturnDueAt: Not(IsNull()),
      },
      take: BATCH,
    });
    for (const { id } of open) {
      const outcome = await this.dataSource.transaction(async (tx) => {
        const row = await tx.findOne(PartRequest, { where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!row || row.faultyReturnedAt || row.faultyReturnChargedAt || !row.faultyReturnDueAt) return null;
        const due = new Date(row.faultyReturnDueAt).getTime();
        if (due <= now.getTime()) {
          await this.cost.chargeUnreturned(tx, row);
          return { kind: 'overdue' as const, row };
        }
        if (!row.faultyReturnRemindedAt && due - now.getTime() <= reminderHours * HOUR_MS) {
          await tx.update(PartRequest, row.id, { faultyReturnRemindedAt: now });
          return { kind: 'reminder' as const, row };
        }
        return null;
      });
      if (!outcome) continue;
      if (outcome.kind === 'reminder') {
        await this.notifier.toUser(
          outcome.row.technicianId, 'Sắp đến hạn nộp linh kiện hỏng',
          'Vui lòng mang linh kiện hỏng về kho trước hạn, nếu không giá linh kiện thay thế sẽ bị trừ vào ví.',
          'WARRANTY_FAULTY_PART_DUE', outcome.row.serviceOrderId,
        );
      } else {
        await this.notifier.toUser(
          outcome.row.technicianId, 'Đã trừ ví vì chưa nộp linh kiện hỏng',
          'Quá hạn nộp linh kiện hỏng nên giá linh kiện thay thế đã bị trừ. Nộp về kho và được kiểm tra không do lắp đặt sẽ được hoàn lại.',
          'WARRANTY_FAULTY_PART_OVERDUE', outcome.row.serviceOrderId,
        );
        await this.notifier.toManagers(
          'Thợ quá hạn nộp linh kiện hỏng', 'Một yêu cầu bảo hành quá hạn nộp linh kiện hỏng, đã trừ ví kỹ thuật viên.',
          'WARRANTY_FAULTY_PART_OVERDUE', outcome.row.serviceOrderId,
        );
      }
    }
  }

  /** A claim waiting for a technician is a customer waiting: remind managers once per round. */
  async sweepUnassigned(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - (await this.hours('warranty.tech_response_hours', 48)) * HOUR_MS);
    const due = await this.dataSource.getRepository(WarrantyClaim).find({
      where: { status: WarrantyClaimStatus.SUBMITTED, technicianId: IsNull(), lastReminderAt: IsNull(), updatedAt: LessThan(cutoff) },
      take: BATCH,
    });
    for (const { id } of due) {
      const claim = await this.dataSource.transaction(async (tx) => {
        const row = await tx.findOne(WarrantyClaim, { where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!row || row.status !== WarrantyClaimStatus.SUBMITTED || row.technicianId || row.lastReminderAt) return null;
        await tx.update(WarrantyClaim, row.id, { lastReminderAt: now });
        return row;
      });
      if (claim) {
        await this.notifier.toManagers(
          'Yêu cầu bảo hành chưa có kỹ thuật viên',
          'Một yêu cầu bảo hành đang chờ phân công kỹ thuật viên quá hạn.',
          'WARRANTY_REASSIGN_NEEDED', claim.serviceOrderId,
        );
      }
    }
  }

  /** Accepted but never checked in by the deadline: flag it for a manager. The manager decides the penalty. */
  async sweepNoShow(now: Date): Promise<void> {
    const window = (await this.hours('warranty.inspection_hours', 72)) * HOUR_MS;
    const visits = await this.dataSource.getRepository(WarrantyVisit).find({
      where: { status: WarrantyVisitStatus.SCHEDULED, createdAt: LessThan(new Date(now.getTime() - window)) },
      take: BATCH * 5,
    });
    for (const visit of visits) {
      const due = Math.max(visit.createdAt.getTime() + window, visit.scheduledAt ? new Date(visit.scheduledAt).getTime() : 0);
      if (due >= now.getTime()) continue;
      const flagged = await this.dataSource.transaction(async (tx) => {
        const claim = await tx.findOne(WarrantyClaim, { where: { id: visit.warrantyClaimId }, lock: { mode: 'pessimistic_write' } });
        if (!claim || claim.status !== WarrantyClaimStatus.ACCEPTED || claim.technicianId !== visit.technicianId
            || claim.noShowFlaggedAt || claim.declineReview === 'pending') return null;
        // Remember who is being judged: a manager may reassign the claim before the verdict.
        await tx.update(WarrantyClaim, claim.id, {
          noShowFlaggedAt: now, declineReview: 'pending',
          declinedByTechnicianId: claim.technicianId, declineReasonCode: 'no_show', declinedAt: now,
        });
        return claim;
      });
      if (flagged) {
        await this.notifier.toManagers(
          'Kỹ thuật viên chưa đến kiểm tra bảo hành',
          'Kỹ thuật viên đã nhận yêu cầu bảo hành nhưng chưa check-in đúng hạn. Vui lòng xem xét.',
          'WARRANTY_NO_SHOW', flagged.serviceOrderId,
        );
      }
    }
  }

  /**
   * A customer who stays silent after the work is reported done accepts it; one who stays silent
   * after a "not covered" conclusion accepts that. Claims created before awaiting_since existed
   * count from their last change.
   */
  async sweepCustomerSilent(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - (await this.hours('warranty.customer_response_hours', 72)) * HOUR_MS);
    const base = { status: WarrantyClaimStatus.AWAITING_CUSTOMER, customerResponse: IsNull() };
    const due = await this.dataSource.getRepository(WarrantyClaim).find({
      where: [
        { ...base, awaitingSince: LessThan(cutoff) },
        { ...base, awaitingSince: IsNull(), updatedAt: LessThan(cutoff) },
      ],
      take: BATCH,
    });
    for (const { id } of due) {
      const closed = await this.dataSource.transaction(async (tx) => {
        const claim = await tx.findOne(WarrantyClaim, { where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!claim || claim.status !== WarrantyClaimStatus.AWAITING_CUSTOMER || claim.customerResponse) return null;
        const accepted = claim.awaitingPrompt === WarrantyCustomerPrompt.COMPLETION;
        await tx.update(WarrantyClaim, claim.id, {
          status: accepted ? WarrantyClaimStatus.RESOLVED : WarrantyClaimStatus.REJECTED,
          outcomeCode: accepted ? 'fixed' : 'rejected',
          awaitingPrompt: null, awaitingSince: null, resolvedAt: now,
          resolutionNotes: claim.resolutionNotes ?? 'Tự đóng do khách hàng không phản hồi đúng hạn.',
        });
        await this.partRequests.settleWarrantyRequest(tx, claim.id);
        return { claim, accepted };
      });
      if (closed) {
        const message = closed.accepted
          ? 'Yêu cầu bảo hành đã tự đóng vì bạn chưa phản hồi. Nếu còn lỗi, vui lòng gửi yêu cầu mới.'
          : 'Yêu cầu bảo hành đã tự đóng vì bạn chưa phản hồi kết luận.';
        await this.notifier.toUser(closed.claim.customerId, 'Yêu cầu bảo hành đã đóng', message, 'WARRANTY_DECISION_MADE', closed.claim.serviceOrderId);
        await this.notifier.toUser(closed.claim.technicianId, 'Yêu cầu bảo hành đã đóng', 'Yêu cầu bảo hành đã tự đóng do khách không phản hồi.', 'WARRANTY_DECISION_MADE', closed.claim.serviceOrderId);
      }
    }
  }

  /** Reads already treat a past date as expired; this keeps the stored status honest. */
  async sweepExpiredCoverage(now: Date): Promise<void> {
    await this.dataSource.query(
      `UPDATE warranty_coverages SET status = $1 WHERE status = $2 AND expires_at < $3
         AND NOT EXISTS (SELECT 1 FROM warranty_claims c WHERE c.warranty_coverage_id = warranty_coverages.id AND c.status::text = ANY($4))`,
      [WarrantyStatus.EXPIRED, WarrantyStatus.ACTIVE, now, [...WARRANTY_CLAIM_ACTIVE_STATUSES]],
    );
  }
}
