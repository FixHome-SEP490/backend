import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  AccountStatus,
  PartSource,
  Role,
  WarrantyClaimStatus,
  WarrantyCustomerPrompt,
  WarrantyInspectionResult,
  WarrantyVisitStatus,
} from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PartRequestsService } from '../part-requests/part-requests.service';
import { QuotationItem } from '../quotations/entities/quotation-item.entity';
import { User } from '../users/entities/user.entity';
import {
  ApproveWarrantyProposalDto,
  AssignWarrantyClaimDto,
  CloseWarrantyClaimDto,
  QueryWarrantyClaimsDto,
  RejectWarrantyClaimDto,
  ReviewWarrantyDeclineDto,
  StaffWarrantyClaimDto,
  TechnicianWarrantyStatDto,
} from './dto/warranty-claim.dto';
import { AdditionalCostItem } from './entities/additional-cost-item.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { WarrantyVisit } from './entities/warranty-visit.entity';
import { WarrantyClaimReadService } from './warranty-claim-read.service';
import { WarrantyCostService } from './warranty-cost.service';
import { WarrantyNotifier } from './warranty-notifier.service';
import type { OrderActor } from './order-access';

const MIN_SAMPLE = 10;
const OPEN_VISIT_STATUSES = [
  WarrantyVisitStatus.SCHEDULED,
  WarrantyVisitStatus.CHECKED_IN,
  WarrantyVisitStatus.INSPECTED,
];

const conflict = (message: string) => new BusinessException(ErrorCodes.CONFLICT, message);
const invalid = (message: string) => new BusinessException(ErrorCodes.VALIDATION_FAILED, message);
const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);

/**
 * Service manager decisions on warranty claims. Nothing here is automatic:
 * every approval, rejection and closure is an explicit manager action.
 */
@Injectable()
export class WarrantyClaimsManagerService {
  constructor(
    @InjectRepository(WarrantyClaim) private readonly claimRepo: Repository<WarrantyClaim>,
    @InjectRepository(WarrantyVisit) private readonly visitRepo: Repository<WarrantyVisit>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly reader: WarrantyClaimReadService,
    private readonly notifier: WarrantyNotifier,
    private readonly auditLog: AuditLogService,
    private readonly dataSource: DataSource,
    private readonly cost: WarrantyCostService,
    private readonly partRequests: PartRequestsService,
  ) {}

  async list(query: QueryWarrantyClaimsDto): Promise<{ data: StaffWarrantyClaimDto[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.technicianId) where.technicianId = query.technicianId;
    if (query.unassigned) where.technicianId = IsNull();
    if (query.declineReview) where.declineReview = query.declineReview;
    const [claims, total] = await this.claimRepo.findAndCount({
      where,
      relations: ['technician'],
      order: { submittedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data: await this.reader.toStaffViews(claims), total };
  }

  /** Technicians a manager may hand a claim to. */
  async eligibleTechnicians(): Promise<{ id: string; fullName: string }[]> {
    const users = await this.userRepo.find({
      where: { role: Role.TECHNICIAN, status: AccountStatus.ACTIVE, isActive: true },
      select: ['id', 'fullName'],
      order: { fullName: 'ASC' },
      take: 200,
    });
    return users.map((user) => ({ id: user.id, fullName: user.fullName }));
  }

  async get(claimId: string): Promise<StaffWarrantyClaimDto> {
    return this.view(await this.mustFind(claimId));
  }

  async assign(claimId: string, dto: AssignWarrantyClaimDto, manager: OrderActor): Promise<StaffWarrantyClaimDto> {
    const claim = await this.mustFind(claimId);
    this.expectStatus(claim, [
      WarrantyClaimStatus.SUBMITTED,
      WarrantyClaimStatus.ACCEPTED,
      WarrantyClaimStatus.INSPECTED,
    ]);
    const technician = await this.userRepo.findOne({
      where: { id: dto.technicianId, role: Role.TECHNICIAN, status: AccountStatus.ACTIVE, isActive: true },
    });
    if (!technician) throw invalid('Không tìm thấy kỹ thuật viên được chọn.');
    const previousTechnicianId = claim.technicianId;

    await this.claimRepo.manager.transaction(async (tx) => {
      const updated = await tx.getRepository(WarrantyClaim).update(
        { id: claim.id, status: claim.status },
        { technicianId: technician.id, status: WarrantyClaimStatus.SUBMITTED, lastReminderAt: null },
      );
      if (updated.affected !== 1) throw conflict('Yêu cầu bảo hành đã được xử lý.');
      await tx
        .getRepository(WarrantyVisit)
        .update({ warrantyClaimId: claim.id, status: In(OPEN_VISIT_STATUSES) }, { status: WarrantyVisitStatus.CANCELLED });
    });
    await this.audit(manager, 'WARRANTY_CLAIM_ASSIGNED', claim, { technicianId: previousTechnicianId }, { technicianId: technician.id });
    await this.notifier.toUser(
      technician.id,
      'Bạn được giao một yêu cầu bảo hành',
      'Quản lý dịch vụ đã giao yêu cầu bảo hành cho bạn. Vui lòng nhận và hẹn lịch kiểm tra.',
      'WARRANTY_INSPECTION_ASSIGNED',
      claim.serviceOrderId,
    );
    return this.view(await this.mustFind(claim.id));
  }

  async approve(claimId: string, dto: ApproveWarrantyProposalDto, manager: OrderActor): Promise<StaffWarrantyClaimDto> {
    const claim = await this.mustFind(claimId);
    this.expectStatus(claim, [WarrantyClaimStatus.INSPECTED]);
    const visit = await this.latestVisit(claim.id, [WarrantyVisitStatus.INSPECTED]);
    const proposed = visit.proposedResult as WarrantyInspectionResult;
    const final = dto.result ?? proposed;
    const covered = final !== WarrantyInspectionResult.NOT_COVERED;
    const reasonCode = covered ? null : (dto.reasonCode ?? visit.notCoveredReasonCode);
    if (!covered && !reasonCode) throw invalid('Cần chọn lý do không bảo hành.');
    if (!covered && !dto.customerNote) throw invalid('Cần nhập nội dung giải thích gửi cho khách hàng.');
    if (final !== proposed && !dto.overrideReason) throw invalid('Cần ghi lý do khi đổi kết luận của kỹ thuật viên.');

    // The decision and the FixHome part it may hand over are one commit.
    await this.dataSource.transaction(async (tx) => {
      const updated = await tx.getRepository(WarrantyClaim).update(
        { id: claim.id, status: WarrantyClaimStatus.INSPECTED },
        {
          status: covered ? WarrantyClaimStatus.IN_PROGRESS : WarrantyClaimStatus.AWAITING_CUSTOMER,
          awaitingPrompt: covered ? null : WarrantyCustomerPrompt.CONCLUSION,
          awaitingSince: covered ? null : new Date(),
          customerResponse: null,
          customerRespondedAt: null,
          resolutionNotes: dto.customerNote ?? null,
          finalResult: final,
          finalReasonCode: reasonCode,
          smOverrodeProposal: final !== proposed,
          reviewedByManagerId: manager.id,
          reviewedAt: new Date(),
        },
      );
      if (updated.affected !== 1) throw conflict('Yêu cầu bảo hành đã được xử lý.');
      if (covered) await this.openPartSupport(tx, claim, final, dto, manager, visit);
    });

    await this.audit(manager, 'WARRANTY_PROPOSAL_APPROVED', claim, { proposed }, { final, reasonCode, overridden: final !== proposed, overrideReason: dto.overrideReason ?? null });
    if (covered) {
      await this.notifier.toUser(claim.technicianId, 'Yêu cầu bảo hành đã được duyệt', 'Vui lòng thực hiện bảo hành miễn phí cho khách hàng.', 'WARRANTY_APPROVED', claim.serviceOrderId);
      await this.notifier.toUser(claim.customerId, 'Yêu cầu bảo hành được chấp nhận', 'Kỹ thuật viên sẽ thực hiện bảo hành miễn phí cho bạn.', 'WARRANTY_DECISION_MADE', claim.serviceOrderId);
    } else {
      await this.notifier.toUser(claim.customerId, 'Cần bạn phản hồi về kết luận bảo hành', 'Vui lòng xem kết luận và cho biết bạn có đồng ý không.', 'WARRANTY_CUSTOMER_RESPONSE_NEEDED', claim.serviceOrderId);
    }
    return this.view(await this.mustFind(claim.id));
  }

  /**
   * FixHome supplies the replacement part only when the fault is the part (PO 04/11/2026). A
   * fault in the technician's workmanship still gets the part, but the technician pays for it;
   * a part the technician bought stays theirs to replace.
   */
  private async openPartSupport(
    tx: EntityManager,
    claim: WarrantyClaim,
    final: WarrantyInspectionResult,
    dto: ApproveWarrantyProposalDto,
    actor: OrderActor,
    visit: WarrantyVisit,
  ): Promise<void> {
    let parts = dto.replacementParts ?? [];
    if (!parts.length && final === WarrantyInspectionResult.COVERED_PART) {
      // The technician saw the faulty parts: supply those lines, FixHome ones only (a part the technician bought stays theirs).
      const lineIds = visit.faultyInvoiceItemIds ?? [];
      const lines = lineIds.length ? await tx.find(InvoiceItem, { where: { id: In(lineIds) } }) : [];
      const merged = new Map<string, number>();
      for (const line of lines) {
        if (line.partSource !== PartSource.FIXHOME) continue;
        const source = line.sourceItemId
          ? (await tx.findOneBy(QuotationItem, { id: line.sourceItemId })) ?? (await tx.findOneBy(AdditionalCostItem, { id: line.sourceItemId }))
          : null;
        if (!source?.partCatalogId) throw invalid('Chọn linh kiện FixHome cấp cho lần bảo hành này.');
        merged.set(source.partCatalogId, (merged.get(source.partCatalogId) ?? 0) + (visit.faultyQuantities?.[line.id] ?? line.quantity));
      }
      parts = [...merged].map(([partCatalogId, quantity]) => ({ partCatalogId, quantity }));
    }
    if (!parts.length) return;
    if (!claim.technicianId) throw invalid('Cần phân công kỹ thuật viên trước khi cấp linh kiện.');
    await this.partRequests.createWarrantyRequest(tx, {
      claim, items: parts, actor,
    });
  }

  /**
   * A decline the system could not verify, or a technician who never answered or showed, waits
   * here. Only a manager's "not justified" costs reputation (same rule as cancellations).
   */
  async reviewDecline(claimId: string, dto: ReviewWarrantyDeclineDto, manager: OrderActor): Promise<StaffWarrantyClaimDto> {
    const claim = await this.mustFind(claimId);
    if (claim.declineReview !== 'pending') throw conflict('Không có từ chối hoặc vắng mặt nào đang chờ xét.');
    const cause = claim.declineReasonCode === 'no_show' ? 'no_show' : 'decline';
    await this.dataSource.transaction(async (tx) => {
      const updated = await tx.getRepository(WarrantyClaim).update(
        { id: claim.id, declineReview: 'pending' },
        { declineReview: dto.valid ? 'valid' : 'invalid' },
      );
      if (updated.affected !== 1) throw conflict('Yêu cầu bảo hành đã được xử lý.');
      if (!dto.valid) {
        await this.cost.penalize(tx, claim, cause, manager.id, cause === 'no_show' ? 'không đến kiểm tra bảo hành' : 'từ chối bảo hành không chính đáng');
      }
    });
    await this.audit(manager, 'WARRANTY_DECLINE_REVIEWED', claim, { declineReview: 'pending' }, { valid: dto.valid, cause, note: dto.note });
    return this.view(await this.mustFind(claim.id));
  }

  async reject(claimId: string, dto: RejectWarrantyClaimDto, manager: OrderActor): Promise<StaffWarrantyClaimDto> {
    const claim = await this.mustFind(claimId);
    this.expectStatus(claim, [
      WarrantyClaimStatus.SUBMITTED,
      WarrantyClaimStatus.ACCEPTED,
      WarrantyClaimStatus.INSPECTED,
    ]);
    await this.claimRepo.manager.transaction(async (tx) => {
      const updated = await tx.getRepository(WarrantyClaim).update(
        { id: claim.id, status: claim.status },
        {
          status: WarrantyClaimStatus.REJECTED,
          awaitingPrompt: null,
          resolutionNotes: dto.customerNote,
          finalResult: WarrantyInspectionResult.NOT_COVERED,
          finalReasonCode: dto.reasonCode,
          reviewedByManagerId: manager.id,
          reviewedAt: new Date(),
          resolvedAt: new Date(),
        },
      );
      if (updated.affected !== 1) throw conflict('Yêu cầu bảo hành đã được xử lý.');
      await tx
        .getRepository(WarrantyVisit)
        .update({ warrantyClaimId: claim.id, status: In(OPEN_VISIT_STATUSES) }, { status: WarrantyVisitStatus.CANCELLED });
    });
    await this.audit(manager, 'WARRANTY_CLAIM_REJECTED', claim, { status: claim.status }, { reasonCode: dto.reasonCode });
    await this.notifier.toUser(claim.customerId, 'Yêu cầu bảo hành không được chấp nhận', dto.customerNote, 'WARRANTY_DECISION_MADE', claim.serviceOrderId);
    await this.notifier.toUser(claim.technicianId, 'Yêu cầu bảo hành đã đóng', 'Quản lý dịch vụ đã từ chối yêu cầu bảo hành này.', 'WARRANTY_DECISION_MADE', claim.serviceOrderId);
    return this.view(await this.mustFind(claim.id));
  }

  async close(claimId: string, dto: CloseWarrantyClaimDto, manager: OrderActor): Promise<StaffWarrantyClaimDto> {
    const claim = await this.mustFind(claimId);
    this.expectStatus(claim, [
      WarrantyClaimStatus.AWAITING_CUSTOMER,
      WarrantyClaimStatus.DISPUTED,
      WarrantyClaimStatus.IN_PROGRESS,
    ]);
    if (claim.status === WarrantyClaimStatus.DISPUTED && claim.reviewedByManagerId === manager.id) {
      throw new BusinessException(
        ErrorCodes.RBAC_FORBIDDEN,
        'Yêu cầu bị phản đối cần do một quản lý khác xem xét lại.',
      );
    }
    const unfixed = dto.outcome === 'unfixed';
    const customerAgreed =
      claim.status === WarrantyClaimStatus.AWAITING_CUSTOMER && claim.customerResponse === 'agreed';
    if (!dto.note && (!customerAgreed || unfixed)) throw invalid('Cần nhập ghi chú khi đóng yêu cầu này.');
    if (unfixed && claim.finalResult === WarrantyInspectionResult.NOT_COVERED) {
      throw invalid('Yêu cầu không thuộc bảo hành không thể đóng với kết cục không khắc phục được.');
    }

    let refund: number | null = null;
    await this.dataSource.transaction(async (tx) => {
      const updated = await tx.getRepository(WarrantyClaim).update(
        { id: claim.id, status: claim.status },
        {
          status: dto.outcome === 'rejected' ? WarrantyClaimStatus.REJECTED : WarrantyClaimStatus.RESOLVED,
          outcomeCode: unfixed ? 'unfixed' : dto.outcome === 'resolved' ? 'fixed' : 'rejected',
          awaitingPrompt: null,
          awaitingSince: null,
          ...(dto.note ? { resolutionNotes: dto.note } : {}),
          resolvedAt: new Date(),
          ...(claim.reviewedByManagerId ? {} : { reviewedByManagerId: manager.id, reviewedAt: new Date() }),
        },
      );
      if (updated.affected !== 1) throw conflict('Yêu cầu bảo hành đã được xử lý.');
      if (unfixed) {
        refund = await this.cost.settleUnfixed(tx, claim, dto.refundAmount);
        await tx.getRepository(WarrantyClaim).update({ id: claim.id }, { refundAmount: refund });
        await this.cost.penalize(tx, claim, 'unfixed', manager.id, 'không khắc phục được trong hạn bảo hành');
      }
      await this.partRequests.settleWarrantyRequest(tx, claim.id);
    });

    await this.audit(manager, 'WARRANTY_CLAIM_CLOSED', claim, { status: claim.status }, { outcome: dto.outcome, refund });
    const message = unfixed
      ? `Không khắc phục được trong hạn bảo hành. ${Number(refund).toLocaleString('vi-VN')} ₫ đã được hoàn vào ví FixHome của khách.`
      : dto.outcome === 'resolved' ? 'Yêu cầu bảo hành đã hoàn tất.' : 'Yêu cầu bảo hành đã được đóng.';
    await this.notifier.toUser(claim.customerId, 'Yêu cầu bảo hành đã đóng', message, 'WARRANTY_DECISION_MADE', claim.serviceOrderId);
    await this.notifier.toUser(claim.technicianId, 'Yêu cầu bảo hành đã đóng', message, 'WARRANTY_DECISION_MADE', claim.serviceOrderId);
    return this.view(await this.mustFind(claim.id));
  }

  /** Warranty rates per technician over a window; computed on demand, never stored as a score. */
  async technicianStats(windowDays = 90): Promise<TechnicianWarrantyStatDto[]> {
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const query = <T>(sql: string) => this.claimRepo.manager.query(sql, [since]) as Promise<T[]>;

    const orders = await query<{ technician_id: string; orders: string }>(
      `SELECT a.technician_id, COUNT(DISTINCT wc.service_order_id) AS orders
         FROM warranty_coverages wc
         JOIN service_orders so ON so.id = wc.service_order_id AND so.status = 'completed' AND so.completed_at >= $1
         JOIN technician_assignments a ON a.service_order_id = so.id AND a.is_active = true
        GROUP BY a.technician_id`,
    );
    const claims = await query<Record<string, string> & { technician_id: string }>(
      `SELECT technician_id,
              COUNT(*) AS claims,
              COUNT(*) FILTER (WHERE final_result IN ('covered_part', 'covered_workmanship')) AS covered,
              COUNT(*) FILTER (WHERE final_result = 'not_covered') AS not_covered,
              COUNT(*) FILTER (WHERE final_result IS NOT NULL AND sm_overrode_proposal) AS overridden,
              COUNT(*) FILTER (WHERE final_result IS NOT NULL) AS decided,
              COUNT(*) FILTER (WHERE customer_response = 'disputed') AS disputed
         FROM warranty_claims
        WHERE technician_id IS NOT NULL AND submitted_at >= $1
        GROUP BY technician_id`,
    );
    const declines = await query<{ technician_id: string; declines: string }>(
      `SELECT declined_by_technician_id AS technician_id, COUNT(*) AS declines
         FROM warranty_claims
        WHERE declined_by_technician_id IS NOT NULL AND declined_at >= $1
        GROUP BY declined_by_technician_id`,
    );

    const ids = [...new Set([...orders, ...claims, ...declines].map((row) => row.technician_id))];
    if (!ids.length) return [];
    const users = await this.userRepo.find({ where: { id: In(ids) }, select: ['id', 'fullName'] });
    const nameById = new Map(users.map((user) => [user.id, user.fullName]));
    const ordersById = new Map(orders.map((row) => [row.technician_id, Number(row.orders)]));
    const claimsById = new Map(claims.map((row) => [row.technician_id, row]));
    const declinesById = new Map(declines.map((row) => [row.technician_id, Number(row.declines)]));

    return ids
      .map((id) => {
        const c = claimsById.get(id);
        const ordersWithWarranty = ordersById.get(id) ?? 0;
        const claimCount = Number(c?.claims ?? 0);
        const covered = Number(c?.covered ?? 0);
        const notCovered = Number(c?.not_covered ?? 0);
        const decided = Number(c?.decided ?? 0);
        const overridden = Number(c?.overridden ?? 0);
        const disputed = Number(c?.disputed ?? 0);
        const declineCount = declinesById.get(id) ?? 0;
        return {
          technicianId: id,
          fullName: nameById.get(id) ?? '',
          ordersWithWarranty,
          claims: claimCount,
          claimRate: ratio(claimCount, ordersWithWarranty),
          covered,
          notCovered,
          notCoveredRate: ratio(notCovered, decided),
          overridden,
          overriddenRate: ratio(overridden, decided),
          disputed,
          disputedRate: ratio(disputed, notCovered),
          declines: declineCount,
          declineRate: ratio(declineCount, claimCount + declineCount),
          lowSample: ordersWithWarranty < MIN_SAMPLE,
        };
      })
      .sort((a, b) => (b.claimRate ?? -1) - (a.claimRate ?? -1));
  }

  private async mustFind(claimId: string): Promise<WarrantyClaim> {
    const claim = await this.claimRepo.findOne({ where: { id: claimId }, relations: ['technician'] });
    if (!claim) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Không tìm thấy yêu cầu bảo hành.');
    return claim;
  }

  private expectStatus(claim: WarrantyClaim, allowed: WarrantyClaimStatus[]): void {
    if (!allowed.includes(claim.status)) {
      throw conflict('Yêu cầu bảo hành không ở bước phù hợp để thực hiện thao tác này.');
    }
  }

  private async latestVisit(claimId: string, statuses: WarrantyVisitStatus[]): Promise<WarrantyVisit> {
    const visits = await this.visitRepo.find({ where: { warrantyClaimId: claimId }, order: { createdAt: 'DESC' } });
    const visit = visits.find((v) => statuses.includes(v.status));
    if (!visit) throw conflict('Chưa có đề xuất kiểm tra để duyệt.');
    return visit;
  }

  private async view(claim: WarrantyClaim): Promise<StaffWarrantyClaimDto> {
    const [view] = await this.reader.toStaffViews([claim]);
    return view;
  }

  private audit(
    manager: OrderActor,
    action: string,
    claim: WarrantyClaim,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<void> {
    return this.auditLog.log({
      actorUserId: manager.id,
      actorRole: manager.role,
      action,
      resourceType: 'warranty_claim',
      resourceId: claim.id,
      before,
      after,
    });
  }
}
