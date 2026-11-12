import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  AccountStatus,
  SupportCaseType,
  ServiceOrderStatus,
  WARRANTY_CLAIM_ACTIVE_STATUSES,
  WarrantyClaimStatus,
  WarrantyStatus,
} from '../../shared/enums';
import { SupportCasesService } from '../support-cases/support-cases.service';
import { User } from '../users/entities/user.entity';
import {
  CreateWarrantyClaimDto,
  RespondWarrantyClaimDto,
  WarrantyClaimViewDto,
} from './dto/warranty-claim.dto';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import { WarrantyVisit } from './entities/warranty-visit.entity';
import { authorizeOrder, type OrderActor } from './order-access';
import { toClaimView } from './warranty-claim.mapper';
import { presentCoverages } from './warranty-coverage-status';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from './entities/service-order.entity';
import { WarrantyNotifier } from './warranty-notifier.service';

@Injectable()
export class WarrantyClaimsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(WarrantyClaim)
    private readonly claimRepo: Repository<WarrantyClaim>,
    private readonly supportCasesService: SupportCasesService,
    private readonly notifier: WarrantyNotifier,
  ) {}

  async create(
    orderId: string,
    dto: CreateWarrantyClaimDto,
    customer: OrderActor,
  ): Promise<WarrantyClaimViewDto> {
    const order = await authorizeOrder(this.dataSource.manager, orderId, customer, 'customer');
    if (order.status !== ServiceOrderStatus.COMPLETED) {
      throw new BusinessException(
        ErrorCodes.ORDER_INVALID_TRANSITION,
        'Chỉ đơn sửa chữa đã hoàn thành mới được yêu cầu bảo hành.',
      );
    }

    const saved = await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      // Lock the parent even when no claim exists. READ COMMITTED lets a waiter
      // see the winning claim in the subsequent query after acquiring this lock.
      const coverage = await manager.getRepository(WarrantyCoverage).findOne({
        where: { id: dto.warrantyCoverageId, serviceOrderId: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!coverage) {
        throw new BusinessException(
          ErrorCodes.NOT_FOUND,
          'Không tìm thấy hạng mục bảo hành của đơn sửa chữa này.',
        );
      }
      if (coverage.status === WarrantyStatus.VOIDED) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Hạng mục này đã bị hủy bảo hành.');
      }

      const claims = manager.getRepository(WarrantyClaim);
      const openClaim = await claims.findOne({
        where: {
          warrantyCoverageId: coverage.id,
          status: In([...WARRANTY_CLAIM_ACTIVE_STATUSES]),
        },
      });
      if (openClaim) {
        throw new BusinessException(
          ErrorCodes.CONFLICT,
          'Hạng mục bảo hành này đang có một yêu cầu chưa xử lý xong.',
        );
      }

      // The technician who did the job handles the claim by default.
      const assignment = await manager.getRepository(TechnicianAssignment).findOne({
        where: { serviceOrderId: orderId },
        order: { assignedAt: 'DESC' },
      });
      // A technician who has since left or been locked cannot take the claim; a manager assigns it.
      const original = assignment?.technicianId
        ? await manager.getRepository(User).findOne({ where: { id: assignment.technicianId, status: AccountStatus.ACTIVE, isActive: true }, select: ['id'] })
        : null;
      const now = new Date();
      return claims.save(claims.create({
        serviceOrderId: orderId,
        warrantyCoverageId: coverage.id,
        customerId: customer.id,
        technicianId: original?.id ?? null,
        description: dto.description,
        evidenceRefs: dto.evidenceRefs?.length ? dto.evidenceRefs : null,
        status: WarrantyClaimStatus.SUBMITTED,
        // Expiry is judged at submission time, not when the technician arrives.
        submittedAfterExpiry: new Date(coverage.expiresAt).getTime() <= now.getTime(),
        submittedAt: now,
      }));
    });

    // WarrantyNotifier is best-effort; notify only after the claim is committed.
    if (!saved.technicianId) {
      await this.notifier.toManagers(
        'Yêu cầu bảo hành chưa có kỹ thuật viên',
        `Kỹ thuật viên của đơn ${order.code} không còn hoạt động. Vui lòng phân công kỹ thuật viên cho yêu cầu bảo hành.`,
        'WARRANTY_REASSIGN_NEEDED',
        orderId,
      );
    }
    await this.notifier.toUser(
      saved.technicianId,
      'Yêu cầu bảo hành mới',
      `Khách hàng vừa gửi yêu cầu bảo hành cho đơn ${order.code}. Vui lòng xem chi tiết và phản hồi.`,
      'WARRANTY_CLAIM_SUBMITTED',
      orderId,
    );
    return this.viewById(saved.id);
  }

  async list(orderId: string, actor: OrderActor): Promise<WarrantyClaimViewDto[]> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    const claims = await this.claimRepo.find({
      where: { serviceOrderId: orderId },
      relations: ['technician'],
      order: { submittedAt: 'DESC' },
    });
    const times = await this.scheduledTimes(claims.map((claim) => claim.id));
    return claims.map((claim) => toClaimView(claim, times.get(claim.id) ?? null));
  }

  /**
   * The customer's warranties page: coverages and claims of several of their own orders in one read
   * (the page used to ask two endpoints per order). Each order comes back exactly as
   * GET /service-orders/:id/warranties and GET /service-orders/:id/warranty-claims return it; an id that
   * is not one of this customer's orders is refused, as those endpoints refuse it.
   */
  async customerWarranties(orderIds: string[], customer: OrderActor) {
    const ids = [...new Set(orderIds.map(id => id.toLowerCase()))];
    if (!ids.length) return [];
    const manager = this.dataSource.manager;
    const owned = await manager.createQueryBuilder(ServiceOrder, 'o')
      .innerJoin(Booking, 'b', 'b.id = o.bookingId AND b.customerId = :customerId', { customerId: customer.id })
      .where('o.id IN (:...ids)', { ids }).select('o.id', 'id').getRawMany<{ id: string }>();
    if (owned.length !== ids.length) throw new ForbiddenException('Order not found or access denied');
    const [coverages, claims] = await Promise.all([
      manager.find(WarrantyCoverage, { where: { serviceOrderId: In(ids) }, order: { expiresAt: 'ASC' } }),
      this.claimRepo.find({ where: { serviceOrderId: In(ids) }, relations: ['technician'], order: { submittedAt: 'DESC' } }),
    ]);
    const [views, times] = await Promise.all([presentCoverages(manager, coverages), this.scheduledTimes(claims.map(claim => claim.id))]);
    return ids.map(orderId => ({
      orderId,
      coverages: views.filter(view => view.serviceOrderId === orderId),
      claims: claims.filter(claim => claim.serviceOrderId === orderId).map(claim => toClaimView(claim, times.get(claim.id) ?? null)),
    }));
  }

  async respond(
    orderId: string,
    claimId: string,
    dto: RespondWarrantyClaimDto,
    customer: OrderActor,
  ): Promise<WarrantyClaimViewDto> {
    const order = await authorizeOrder(this.dataSource.manager, orderId, customer, 'customer');
    const claim = await this.claimRepo.findOne({ where: { id: claimId, serviceOrderId: orderId } });
    if (!claim || claim.customerId !== customer.id) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Không tìm thấy yêu cầu bảo hành.');
    }
    if (claim.status !== WarrantyClaimStatus.AWAITING_CUSTOMER || claim.customerResponse) {
      throw new BusinessException(
        ErrorCodes.CONFLICT,
        'Yêu cầu bảo hành này không còn chờ phản hồi của bạn.',
      );
    }

    const now = new Date();
    if (dto.decision === 'agree') {
      const result = await this.claimRepo.update(
        { id: claim.id, status: WarrantyClaimStatus.AWAITING_CUSTOMER, customerResponse: IsNull() },
        { customerResponse: 'agreed', customerRespondedAt: now },
      );
      if (result.affected !== 1) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Bạn đã phản hồi yêu cầu bảo hành này.');
      }
    } else {
      await this.claimRepo.manager.transaction(async (manager) => {
        const repo = manager.getRepository(WarrantyClaim);
        const result = await repo.update(
          { id: claim.id, status: WarrantyClaimStatus.AWAITING_CUSTOMER, customerResponse: IsNull() },
          { status: WarrantyClaimStatus.DISPUTED, customerResponse: 'disputed', customerRespondedAt: now },
        );
        if (result.affected !== 1) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Bạn đã phản hồi yêu cầu bảo hành này.');
        }
        const supportCase = await this.supportCasesService.openCase(
          {
            caseType: SupportCaseType.WARRANTY_DISPUTE,
            reason: dto.note as string,
            bookingId: order.bookingId,
            serviceOrderId: order.id,
            customerId: customer.id,
            technicianId: claim.technicianId,
            createdByUserId: customer.id,
          },
          manager,
        );
        await repo.update({ id: claim.id }, { escalatedSupportCaseId: supportCase.id });
      });
    }
    return this.viewById(claim.id);
  }

  private async viewById(id: string): Promise<WarrantyClaimViewDto> {
    const claim = await this.claimRepo.findOneOrFail({ where: { id }, relations: ['technician'] });
    const times = await this.scheduledTimes([id]);
    return toClaimView(claim, times.get(id) ?? null);
  }

  /** The newest scheduled inspection time per claim, for the customer's view. */
  private async scheduledTimes(claimIds: string[]): Promise<Map<string, Date | null>> {
    if (!claimIds.length) return new Map();
    const visits = await this.claimRepo.manager.find(WarrantyVisit, {
      where: { warrantyClaimId: In(claimIds) },
      order: { createdAt: 'ASC' },
    });
    return new Map(visits.map((visit) => [visit.warrantyClaimId, visit.scheduledAt ?? null]));
  }
}
