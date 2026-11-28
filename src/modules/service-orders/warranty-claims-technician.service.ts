import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  CostItemType,
  PartRequestStatus,
  PartUsageStatus,
  WarrantyClaimStatus,
  WarrantyCustomerPrompt,
  WarrantyInspectionResult,
  WarrantyStatus,
  WarrantyVisitStatus,
} from '../../shared/enums';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { PartRequestItem } from '../part-requests/entities/part-request-item.entity';
import { Invoice } from './entities/invoice.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { ServiceOrder } from './entities/service-order.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import {
  AcceptWarrantyClaimDto,
  CheckInWarrantyVisitDto,
  CompleteWarrantyReServiceDto,
  ProposeWarrantyInspectionDto,
  StaffWarrantyClaimDto,
} from './dto/warranty-claim.dto';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { WarrantyVisit } from './entities/warranty-visit.entity';
import { WarrantyClaimReadService } from './warranty-claim-read.service';
import { WarrantyNotifier } from './warranty-notifier.service';
import type { OrderActor } from './order-access';

const conflict = (message: string) => new BusinessException(ErrorCodes.CONFLICT, message);
const invalid = (message: string) => new BusinessException(ErrorCodes.VALIDATION_FAILED, message);

/**
 * Commands the technician assigned to a claim can run. Every conclusion is only a
 * proposal: the service manager approves it before the customer sees anything.
 */
@Injectable()
export class WarrantyClaimsTechnicianService {
  constructor(
    @InjectRepository(WarrantyClaim) private readonly claimRepo: Repository<WarrantyClaim>,
    @InjectRepository(WarrantyVisit) private readonly visitRepo: Repository<WarrantyVisit>,
    private readonly reader: WarrantyClaimReadService,
    private readonly notifier: WarrantyNotifier,
  ) {}

  /** Newest first; without paging the first 100 as before (the app reads it that way). */
  async listMine(technician: OrderActor, status?: WarrantyClaimStatus, page = 1, pageSize = 100): Promise<{ items: StaffWarrantyClaimDto[]; total: number }> {
    const [claims, total] = await this.claimRepo.findAndCount({
      where: { technicianId: technician.id, ...(status ? { status } : {}) },
      relations: ['technician'],
      order: { submittedAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items: await this.reader.toStaffViews(claims), total };
  }

  /** One claim of mine; a claim handed back or assigned to someone else is simply not found. */
  async getMine(claimId: string, technician: OrderActor): Promise<StaffWarrantyClaimDto> {
    const claim = await this.claimRepo.findOne({ where: { id: claimId, technicianId: technician.id }, relations: ['technician'] });
    if (!claim) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Không tìm thấy yêu cầu bảo hành.');
    const [view] = await this.reader.toStaffViews([claim]);
    return view;
  }

  async accept(claimId: string, dto: AcceptWarrantyClaimDto, technician: OrderActor): Promise<StaffWarrantyClaimDto> {
    const scheduledAt = futureTime(dto.scheduledAt);
    const claim = await this.ownClaim(claimId, technician.id, WarrantyClaimStatus.SUBMITTED);
    await this.claimRepo.manager.transaction(async (manager) => {
      const updated = await manager
        .getRepository(WarrantyClaim)
        .update(
          { id: claim.id, status: WarrantyClaimStatus.SUBMITTED, technicianId: technician.id },
          { status: WarrantyClaimStatus.ACCEPTED },
        );
      if (updated.affected !== 1) throw conflict('Yêu cầu bảo hành đã được xử lý.');
      const visits = manager.getRepository(WarrantyVisit);
      await visits.save(
        visits.create({
          warrantyClaimId: claim.id,
          technicianId: technician.id,
          status: WarrantyVisitStatus.SCHEDULED,
          scheduledAt,
        }),
      );
    });
    await this.notifier.toUser(
      claim.customerId,
      'Kỹ thuật viên đã nhận yêu cầu bảo hành',
      `Kỹ thuật viên hẹn kiểm tra lúc ${scheduledAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })}.`,
      'WARRANTY_CLAIM_ACCEPTED',
      claim.serviceOrderId,
    );
    return this.viewOf(claim.id);
  }

  /** The customer cannot make the agreed time: move it, as long as the technician has not checked in yet. */
  async reschedule(claimId: string, dto: AcceptWarrantyClaimDto, technician: OrderActor): Promise<StaffWarrantyClaimDto> {
    const scheduledAt = futureTime(dto.scheduledAt);
    const claim = await this.ownClaim(claimId, technician.id, WarrantyClaimStatus.ACCEPTED);
    const visit = await this.latestVisit(claim.id, technician.id, [WarrantyVisitStatus.SCHEDULED]);
    const updated = await this.visitRepo.update({ id: visit.id, status: WarrantyVisitStatus.SCHEDULED }, { scheduledAt });
    if (updated.affected !== 1) throw conflict('Lượt kiểm tra đã bắt đầu, không thể đổi lịch.');
    await this.notifier.toUser(
      claim.customerId,
      'Lịch kiểm tra bảo hành đã đổi',
      `Kỹ thuật viên hẹn lại kiểm tra lúc ${scheduledAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })}.`,
      'WARRANTY_VISIT_RESCHEDULED',
      claim.serviceOrderId,
    );
    return this.viewOf(claim.id);
  }

  async checkIn(claimId: string, dto: CheckInWarrantyVisitDto, technician: OrderActor): Promise<StaffWarrantyClaimDto> {
    const claim = await this.ownClaim(claimId, technician.id, WarrantyClaimStatus.ACCEPTED);
    const visit = await this.latestVisit(claim.id, technician.id, [
      WarrantyVisitStatus.SCHEDULED,
      WarrantyVisitStatus.CHECKED_IN,
    ]);
    if (visit.status === WarrantyVisitStatus.SCHEDULED) {
      // ponytail: location is recorded, not geofenced; reuse the order geofence check when SM asks for it
      await this.visitRepo.update(
        { id: visit.id, status: WarrantyVisitStatus.SCHEDULED },
        {
          status: WarrantyVisitStatus.CHECKED_IN,
          checkedInAt: new Date(),
          checkInLat: dto.lat !== undefined ? String(dto.lat) : null,
          checkInLng: dto.lng !== undefined ? String(dto.lng) : null,
        },
      );
    }
    return this.viewOf(claim.id);
  }

  async propose(claimId: string, dto: ProposeWarrantyInspectionDto, technician: OrderActor): Promise<StaffWarrantyClaimDto> {
    const claim = await this.ownClaim(claimId, technician.id, WarrantyClaimStatus.ACCEPTED);
    const notCovered = dto.result === WarrantyInspectionResult.NOT_COVERED;
    if (notCovered && !dto.evidenceRefs?.length) {
      throw invalid('Cần ít nhất một ảnh hoặc video làm bằng chứng khi kết luận không bảo hành.');
    }
    if (dto.result === WarrantyInspectionResult.COVERED_PART && !dto.evidenceRefs?.length) {
      throw invalid('Cần ít nhất một ảnh hoặc video của linh kiện hỏng khi kết luận lỗi linh kiện.');
    }
    const visit = await this.latestVisit(claim.id, technician.id, [WarrantyVisitStatus.CHECKED_IN]);
    const faulty = dto.result === WarrantyInspectionResult.COVERED_PART ? await this.faultyPartLines(claim.serviceOrderId, dto.faultyInvoiceItemIds ?? [], dto.faultyQuantities) : null;

    // A workmanship fault with no part costs FixHome nothing and runs against the technician's own interest:
    // the service manager has nothing to approve, so the claim goes straight to the re-service. Late or voided claims still need a manager.
    const coverage = dto.result === WarrantyInspectionResult.COVERED_WORKMANSHIP
      ? await this.claimRepo.manager.findOneBy(WarrantyCoverage, { id: claim.warrantyCoverageId })
      : null;
    const auto = !!coverage && coverage.status !== WarrantyStatus.VOIDED && !claim.submittedAfterExpiry;

    await this.claimRepo.manager.transaction(async (manager) => {
      const updated = await manager
        .getRepository(WarrantyClaim)
        .update(
          { id: claim.id, status: WarrantyClaimStatus.ACCEPTED, technicianId: technician.id },
          auto
            ? {
                status: WarrantyClaimStatus.IN_PROGRESS,
                awaitingPrompt: null,
                awaitingSince: null,
                customerResponse: null,
                customerRespondedAt: null,
                finalResult: WarrantyInspectionResult.COVERED_WORKMANSHIP,
                finalReasonCode: null,
                smOverrodeProposal: false,
                reviewedByManagerId: null,
                reviewedAt: new Date(),
              }
            : { status: WarrantyClaimStatus.INSPECTED },
        );
      if (updated.affected !== 1) throw conflict('Yêu cầu bảo hành đã được xử lý.');
      await manager.getRepository(WarrantyVisit).update(
        { id: visit.id, status: WarrantyVisitStatus.CHECKED_IN },
        {
          status: WarrantyVisitStatus.INSPECTED,
          proposedResult: dto.result,
          notCoveredReasonCode: notCovered ? (dto.notCoveredReasonCode ?? null) : null,
          findings: dto.findings,
          evidenceRefs: dto.evidenceRefs?.length ? dto.evidenceRefs : null,
          faultyInvoiceItemIds: faulty?.ids ?? null,
          faultyQuantities: faulty?.quantities ?? null,
        },
      );
    });
    if (auto) {
      await this.notifier.toManagers(
        'Yêu cầu bảo hành được tự động duyệt',
        'Lỗi do công lắp đặt, không cần linh kiện: kỹ thuật viên sửa lại miễn phí, không cần duyệt. Xem lại khi cần.',
        'WARRANTY_AUTO_APPROVED',
        claim.serviceOrderId,
      );
      await this.notifier.toUser(
        claim.customerId,
        'Yêu cầu bảo hành được chấp nhận',
        'Kỹ thuật viên sẽ thực hiện bảo hành miễn phí cho bạn.',
        'WARRANTY_DECISION_MADE',
        claim.serviceOrderId,
      );
    } else {
      await this.notifier.toManagers(
        'Có đề xuất kết luận bảo hành cần duyệt',
        'Kỹ thuật viên đã kiểm tra và gửi đề xuất kết luận. Vui lòng xem xét.',
        'WARRANTY_PROPOSAL_READY',
        claim.serviceOrderId,
      );
    }
    return this.viewOf(claim.id);
  }

  /** The faulty lines must be part lines of the original job's own invoice, so a technician cannot name a stranger's part. */
  private async faultyPartLines(serviceOrderId: string, ids: string[], quantities?: Record<string, number>): Promise<{ ids: string[]; quantities: Record<string, number> | null }> {
    const unique = [...new Set(ids)];
    if (!unique.length) throw invalid('Chọn ít nhất một linh kiện bị hỏng.');
    const manager = this.claimRepo.manager;
    const invoice = await manager.findOneBy(Invoice, { serviceOrderId });
    const lines = invoice ? await manager.find(InvoiceItem, { where: { invoiceId: invoice.id, type: CostItemType.PARTS_EQUIPMENT } }) : [];
    const bought = new Map(lines.map((line) => [line.id, line.quantity]));
    if (unique.some((id) => !bought.has(id))) throw invalid('Linh kiện được chọn không thuộc đơn sửa chữa gốc.');
    if (!quantities) return { ids: unique, quantities: null };
    const counted: Record<string, number> = {};
    for (const id of unique) {
      const n = quantities[id] ?? bought.get(id)!;
      if (!Number.isInteger(n) || n < 1 || n > bought.get(id)!) throw invalid('Số lượng linh kiện hỏng không hợp lệ.');
      counted[id] = n;
    }
    if (Object.keys(quantities).some((id) => !unique.includes(id))) throw invalid('Số lượng linh kiện hỏng không hợp lệ.');
    return { ids: unique, quantities: counted };
  }

  async complete(claimId: string, dto: CompleteWarrantyReServiceDto, technician: OrderActor): Promise<StaffWarrantyClaimDto> {
    const claim = await this.ownClaim(claimId, technician.id, WarrantyClaimStatus.IN_PROGRESS);
    const visit = await this.latestVisit(claim.id, technician.id, [WarrantyVisitStatus.INSPECTED]);

    // The replacement part has to be received and declared fitted (or returned) first; the faulty part can be handed in afterwards.
    const request = await this.claimRepo.manager.findOneBy(PartRequest, { warrantyClaimId: claim.id });
    if (request && request.status !== PartRequestStatus.CANCELLED) {
      const items = await this.claimRepo.manager.find(PartRequestItem, { where: { partRequestId: request.id } });
      if (![PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED].includes(request.status) || items.some((i) => i.usageStatus === PartUsageStatus.PENDING)) {
        throw conflict('Cần nhận linh kiện thay thế và khai đã lắp hoặc trả lại trước khi báo hoàn tất.');
      }
    }

    await this.claimRepo.manager.transaction(async (manager) => {
      const updated = await manager.getRepository(WarrantyClaim).update(
        { id: claim.id, status: WarrantyClaimStatus.IN_PROGRESS, technicianId: technician.id },
        {
          status: WarrantyClaimStatus.AWAITING_CUSTOMER,
          awaitingSince: new Date(),
          awaitingPrompt: WarrantyCustomerPrompt.COMPLETION,
          customerResponse: null,
          customerRespondedAt: null,
        },
      );
      if (updated.affected !== 1) throw conflict('Yêu cầu bảo hành đã được xử lý.');
      await manager.getRepository(WarrantyVisit).update(
        { id: visit.id, status: WarrantyVisitStatus.INSPECTED },
        {
          status: WarrantyVisitStatus.COMPLETED,
          reServiceNotes: dto.notes,
          reServiceEvidenceRefs: dto.evidenceRefs?.length ? dto.evidenceRefs : null,
          completedAt: new Date(),
        },
      );
    });
    await this.notifier.toUser(
      claim.customerId,
      'Vui lòng xác nhận bảo hành đã hoàn tất',
      'Kỹ thuật viên báo đã xử lý xong. Hãy kiểm tra và xác nhận.',
      'WARRANTY_CUSTOMER_RESPONSE_NEEDED',
      claim.serviceOrderId,
    );
    return this.viewOf(claim.id);
  }

  /** 404 for a claim that is not the caller's, 409 when it is in the wrong state. */
  private async ownClaim(claimId: string, technicianId: string, expected: WarrantyClaimStatus): Promise<WarrantyClaim> {
    const claim = await this.claimRepo.findOne({ where: { id: claimId } });
    if (!claim || claim.technicianId !== technicianId) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Không tìm thấy yêu cầu bảo hành.');
    }
    if (claim.status !== expected) {
      throw conflict('Yêu cầu bảo hành không ở bước phù hợp để thực hiện thao tác này.');
    }
    return claim;
  }

  private async latestVisit(claimId: string, technicianId: string, statuses: WarrantyVisitStatus[]): Promise<WarrantyVisit> {
    const visits = await this.visitRepo.find({
      where: { warrantyClaimId: claimId, technicianId },
      order: { createdAt: 'DESC' },
    });
    const visit = visits.find((v) => statuses.includes(v.status));
    if (!visit) throw conflict('Lượt kiểm tra chưa ở bước phù hợp. Hãy xác nhận đã đến nơi trước.');
    return visit;
  }

  private async viewOf(claimId: string): Promise<StaffWarrantyClaimDto> {
    const claim = await this.claimRepo.findOneOrFail({ where: { id: claimId }, relations: ['technician'] });
    const [view] = await this.reader.toStaffViews([claim]);
    return view;
  }
}

function futureTime(value: string): Date {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
    throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Lịch kiểm tra phải ở thời điểm sau hiện tại.');
  }
  return at;
}
