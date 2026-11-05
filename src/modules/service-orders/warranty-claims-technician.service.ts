import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  WarrantyClaimStatus,
  WarrantyCustomerPrompt,
  WarrantyDeclineReason,
  WarrantyInspectionResult,
  WarrantyVisitStatus,
} from '../../shared/enums';
import { Address } from '../users/entities/address.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { distanceToBooking, servesArea, technicianOrigin } from '../bookings/technician-location';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianServiceArea } from '../technicians/entities/technician-service-area.entity';
import { ServiceOrder } from './entities/service-order.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
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

// ponytail: fixed window; make it a system_configs key if the ops team wants to tune it.
const LATE_DECLINE_WINDOW_MS = 24 * 3600_000;

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
    const verdict = await this.declineVerdict(this.claimRepo.manager, claim, technician.id, dto.reasonCode);
    // Close to expiry only a reason the system can verify lets the technician step back.
    const coverage = await this.claimRepo.manager.findOneBy(WarrantyCoverage, { id: claim.warrantyCoverageId });
    if (verdict === 'pending' && coverage && new Date(coverage.expiresAt).getTime() - Date.now() < LATE_DECLINE_WINDOW_MS) {
      throw invalid('Sát hạn bảo hành, chỉ được từ chối khi đang nghỉ phép hoặc ngoài khu vực phục vụ. Vui lòng liên hệ quản lý dịch vụ.');
    }
    const updated = await this.claimRepo.update(
      { id: claim.id, status: WarrantyClaimStatus.SUBMITTED, technicianId: technician.id },
      {
        technicianId: null,
        declinedByTechnicianId: technician.id,
        declineReasonCode: dto.reasonCode,
        declineNote: dto.note ?? null,
        declinedAt: new Date(),
        // A decline the system could not verify waits for a manager to judge it before it costs reputation.
        declineReview: verdict === 'valid' ? 'valid' : 'pending',
      },
    );
    if (updated.affected !== 1) throw conflict('Yêu cầu bảo hành đã được xử lý.');
    await this.notifier.toManagers(
      'Cần phân công lại yêu cầu bảo hành',
      `Kỹ thuật viên không nhận yêu cầu bảo hành (lý do: ${dto.reasonCode}${verdict === 'pending' ? ', chưa xác minh được' : ', đã xác minh'}). Vui lòng phân công kỹ thuật viên khác.`,
      'WARRANTY_REASSIGN_NEEDED',
      claim.serviceOrderId,
    );
    return this.viewOf(claim.id);
  }

  /** On leave and out of area can be checked against the technician's own records; the rest cannot. */
  private async declineVerdict(manager: EntityManager, claim: WarrantyClaim, technicianId: string, reason: WarrantyDeclineReason): Promise<'valid' | 'pending'> {
    const profile = await manager.findOneBy(TechnicianProfile, { userId: technicianId });
    if (!profile) return 'pending';
    if (reason === WarrantyDeclineReason.ON_LEAVE) {
      const suspended = profile.workSuspendedUntil && new Date(profile.workSuspendedUntil) > new Date();
      return !profile.isAvailable || suspended ? 'valid' : 'pending';
    }
    if (reason === WarrantyDeclineReason.OUT_OF_AREA) {
      const order = await manager.findOneBy(ServiceOrder, { id: claim.serviceOrderId });
      const booking = order ? await manager.findOneBy(Booking, { id: order.bookingId }) : null;
      if (!booking) return 'pending';
      const address = await manager.findOneBy(Address, { userId: technicianId, isDefault: true });
      const areas = await manager.find(TechnicianServiceArea, { where: { technicianId: profile.id } });
      const origin = technicianOrigin('scheduled', profile, address, 0);
      const distance = distanceToBooking(origin, booking);
      const outside = !servesArea(areas, booking) || (distance != null && distance > Number(profile.serviceRadiusKm));
      return outside ? 'valid' : 'pending';
    }
    return 'pending';
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
