import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  SupportCaseType,
  ServiceOrderStatus,
  WARRANTY_CLAIM_ACTIVE_STATUSES,
  WarrantyClaimStatus,
  WarrantyStatus,
} from '../../shared/enums';
import { SupportCasesService } from '../support-cases/support-cases.service';
import {
  CreateWarrantyClaimDto,
  RespondWarrantyClaimDto,
  WarrantyClaimViewDto,
} from './dto/warranty-claim.dto';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import { authorizeOrder, type OrderActor } from './order-access';
import { toClaimView } from './warranty-claim.mapper';
import { WarrantyNotifier } from './warranty-notifier.service';

@Injectable()
export class WarrantyClaimsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(WarrantyClaim)
    private readonly claimRepo: Repository<WarrantyClaim>,
    @InjectRepository(WarrantyCoverage)
    private readonly coverageRepo: Repository<WarrantyCoverage>,
    @InjectRepository(TechnicianAssignment)
    private readonly assignmentRepo: Repository<TechnicianAssignment>,
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

    const coverage = await this.coverageRepo.findOneBy({
      id: dto.warrantyCoverageId,
      serviceOrderId: orderId,
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

    const openClaim = await this.claimRepo.findOne({
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
    const assignment = await this.assignmentRepo.findOne({
      where: { serviceOrderId: orderId },
      order: { assignedAt: 'DESC' },
    });
    const now = new Date();
    const saved = await this.claimRepo.save(
      this.claimRepo.create({
        serviceOrderId: orderId,
        warrantyCoverageId: coverage.id,
        customerId: customer.id,
        technicianId: assignment?.technicianId ?? null,
        description: dto.description,
        evidenceRefs: dto.evidenceRefs?.length ? dto.evidenceRefs : null,
        status: WarrantyClaimStatus.SUBMITTED,
        // Expiry is judged at submission time, not when the technician arrives.
        submittedAfterExpiry: new Date(coverage.expiresAt).getTime() <= now.getTime(),
        submittedAt: now,
      }),
    );

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
    return claims.map(toClaimView);
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
    return toClaimView(claim);
  }
}
