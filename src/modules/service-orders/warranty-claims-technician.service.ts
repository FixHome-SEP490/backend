import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  WarrantyClaimStatus,
  WarrantyCustomerPrompt,
  WarrantyInspectionResult,
  WarrantyVisitStatus,
} from '../../shared/enums';
import {
  AcceptWarrantyClaimDto,
  CheckInWarrantyVisitDto,
  CompleteWarrantyReServiceDto,
  DeclineWarrantyClaimDto,
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

  async listMine(technician: OrderActor, status?: WarrantyClaimStatus): Promise<StaffWarrantyClaimDto[]> {
    const claims = await this.claimRepo.find({
      where: { technicianId: technician.id, ...(status ? { status } : {}) },
      relations: ['technician'],
      order: { submittedAt: 'DESC' },
      take: 100,
    });
    return this.reader.toStaffViews(claims);
  }

  async accept(claimId: string, dto: AcceptWarrantyClaimDto, technician: OrderActor): Promise<StaffWarrantyClaimDto> {
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
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        }),
      );
    });
    await this.notifier.toUser(
      claim.customerId,
      'Kỹ thuật viên đã nhận yêu cầu bảo hành',
      'Kỹ thuật viên phụ trách sẽ liên hệ để hẹn lịch kiểm tra.',
      'WARRANTY_CLAIM_ACCEPTED',
      claim.serviceOrderId,
    );
    return this.viewOf(claim.id);
  }

  async decline(claimId: string, dto: DeclineWarrantyClaimDto, technician: OrderActor): Promise<StaffWarrantyClaimDto> {
    const claim = await this.ownClaim(claimId, technician.id, WarrantyClaimStatus.SUBMITTED);
    const updated = await this.claimRepo.update(
      { id: claim.id, status: WarrantyClaimStatus.SUBMITTED, technicianId: technician.id },
      {
        technicianId: null,
        declinedByTechnicianId: technician.id,
        declineReasonCode: dto.reasonCode,
        declineNote: dto.note ?? null,
        declinedAt: new Date(),
      },
    );
    if (updated.affected !== 1) throw conflict('Yêu cầu bảo hành đã được xử lý.');
    await this.notifier.toManagers(
      'Cần phân công lại yêu cầu bảo hành',
      `Kỹ thuật viên không nhận yêu cầu bảo hành (lý do: ${dto.reasonCode}). Vui lòng phân công kỹ thuật viên khác.`,
      'WARRANTY_REASSIGN_NEEDED',
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
    const visit = await this.latestVisit(claim.id, technician.id, [WarrantyVisitStatus.CHECKED_IN]);

    await this.claimRepo.manager.transaction(async (manager) => {
      const updated = await manager
        .getRepository(WarrantyClaim)
        .update(
          { id: claim.id, status: WarrantyClaimStatus.ACCEPTED, technicianId: technician.id },
          { status: WarrantyClaimStatus.INSPECTED },
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
        },
      );
    });
    await this.notifier.toManagers(
      'Có đề xuất kết luận bảo hành cần duyệt',
      'Kỹ thuật viên đã kiểm tra và gửi đề xuất kết luận. Vui lòng xem xét.',
      'WARRANTY_PROPOSAL_READY',
      claim.serviceOrderId,
    );
    return this.viewOf(claim.id);
  }

  async complete(claimId: string, dto: CompleteWarrantyReServiceDto, technician: OrderActor): Promise<StaffWarrantyClaimDto> {
    const claim = await this.ownClaim(claimId, technician.id, WarrantyClaimStatus.IN_PROGRESS);
    const visit = await this.latestVisit(claim.id, technician.id, [WarrantyVisitStatus.INSPECTED]);

    await this.claimRepo.manager.transaction(async (manager) => {
      const updated = await manager.getRepository(WarrantyClaim).update(
        { id: claim.id, status: WarrantyClaimStatus.IN_PROGRESS, technicianId: technician.id },
        {
          status: WarrantyClaimStatus.AWAITING_CUSTOMER,
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
