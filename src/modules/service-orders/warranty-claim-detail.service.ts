import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { DataSource } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { PartRequestItem } from '../part-requests/entities/part-request-item.entity';
import { User } from '../users/entities/user.entity';
import { StaffWarrantyClaimDto } from './dto/warranty-claim.dto';
import { Invoice } from './entities/invoice.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import { WarrantyVisit } from './entities/warranty-visit.entity';
import { WarrantyClaimReadService } from './warranty-claim-read.service';
import { toVisitView } from './warranty-claim.mapper';
import { effectiveWarrantyStatus } from './warranty-coverage-status';

type Person = { id: string; fullName: string } | null;

/** Everything a service manager needs to judge one claim, in one read. */
export interface WarrantyClaimDetailDto extends StaffWarrantyClaimDto {
  detail: {
    decision: {
      finalResult: string | null;
      finalReasonCode: string | null;
      smOverrodeProposal: boolean;
      reviewedBy: Person;
      reviewedAt: Date | null;
      customerRespondedAt: Date | null;
      awaitingSince: Date | null;
      escalatedSupportCaseId: string | null;
    };
    declined: { by: Person; at: Date | null; reasonCode: string | null; note: string | null } | null;
    originalJob: {
      completedAt: Date | null;
      paymentStatus: string;
      laborTotal: number;
      partsTotal: number;
      grandTotal: number;
      laborWarrantyDays: number | null;
      technicians: { id: string; fullName: string; assignedAt: Date; isActive: boolean }[];
      lines: {
        id: string;
        type: string;
        description: string;
        quantity: number;
        unitPrice: number;
        lineTotal: number;
        warrantyDays: number;
        partSource: string | null;
        partWarrantyOption: string | null;
        covered: boolean;
        /** The technician named this line as faulty when proposing a part fault. */
        faulty: boolean;
        /** How many of this line are faulty (the whole line unless the technician said fewer). */
        faultyQuantity: number;
      }[];
    };
    coverage: { id: string; startsAt: Date; expiresAt: Date; warrantyDays: number; status: string } | null;
    visits: (ReturnType<typeof toVisitView> & { technician: Person })[];
    partRequest: {
      id: string;
      status: string;
      chargeTechnician: boolean;
      faultyInspectionResult: string | null;
      faultyInspectionNote: string | null;
      faultyInspectionEvidence: string[] | null;
      faultyInspectedAt: Date | null;
      faultyReturnDueAt: Date | null;
      faultyReturnedAt: Date | null;
      faultyReturnNote: string | null;
      faultyReturnEvidence: string[] | null;
      faultyReturnChargedAt: Date | null;
      items: { id: string; name: string; quantity: number; unitPrice: number; usageStatus: string }[];
    } | null;
    otherClaims: { id: string; status: string; submittedAt: Date; itemDescription: string }[];
  };
}

@Injectable()
export class WarrantyClaimDetailService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(WarrantyClaim) private readonly claimRepo: Repository<WarrantyClaim>,
    private readonly reader: WarrantyClaimReadService,
  ) {}

  async get(claimId: string): Promise<WarrantyClaimDetailDto> {
    const claim = await this.claimRepo.findOne({ where: { id: claimId }, relations: ['technician'] });
    if (!claim) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Không tìm thấy yêu cầu bảo hành.');
    const [view] = await this.reader.toStaffViews([claim]);
    const manager = this.dataSource.manager;

    const order = await manager.findOneBy(ServiceOrder, { id: claim.serviceOrderId });
    const assignments = await manager.find(TechnicianAssignment, { where: { serviceOrderId: claim.serviceOrderId }, order: { assignedAt: 'ASC' } });
    const invoice = await manager.findOneBy(Invoice, { serviceOrderId: claim.serviceOrderId });
    const lines = invoice ? await manager.find(InvoiceItem, { where: { invoiceId: invoice.id } }) : [];
    const coverage = await manager.findOneBy(WarrantyCoverage, { id: claim.warrantyCoverageId });
    const visits = await manager.find(WarrantyVisit, { where: { warrantyClaimId: claim.id }, order: { createdAt: 'ASC' } });
    const faultyIds = new Set(visits.flatMap((v) => v.faultyInvoiceItemIds ?? []));
    const faultyQuantities = visits.reduce<Record<string, number>>((all, v) => ({ ...all, ...(v.faultyQuantities ?? {}) }), {});
    const request = await manager.findOneBy(PartRequest, { warrantyClaimId: claim.id });
    const requestItems = request ? await manager.find(PartRequestItem, { where: { partRequestId: request.id } }) : [];
    const others = await manager.find(WarrantyClaim, { where: { serviceOrderId: claim.serviceOrderId, id: Not(claim.id) }, order: { submittedAt: 'DESC' }, take: 10 });
    const otherCoverages = others.length ? await manager.find(WarrantyCoverage, { where: { id: In(others.map((c) => c.warrantyCoverageId)) } }) : [];

    const userIds = [...new Set([
      ...assignments.map((a) => a.technicianId), ...visits.map((v) => v.technicianId),
      claim.reviewedByManagerId, claim.declinedByTechnicianId,
    ].filter((id): id is string => !!id))];
    const users = userIds.length ? await manager.find(User, { where: { id: In(userIds) }, select: ['id', 'fullName'] }) : [];
    const person = (id?: string | null): Person => {
      const user = id ? users.find((u) => u.id === id) : undefined;
      return user ? { id: user.id, fullName: user.fullName } : null;
    };
    const lineLabel = (coverageId: string) => {
      const itemId = otherCoverages.find((c) => c.id === coverageId)?.invoiceItemId;
      return lines.find((l) => l.id === itemId)?.description ?? 'Bảo hành dịch vụ';
    };

    return {
      ...view,
      detail: {
        decision: {
          finalResult: claim.finalResult ?? null,
          finalReasonCode: claim.finalReasonCode ?? null,
          smOverrodeProposal: claim.smOverrodeProposal,
          reviewedBy: person(claim.reviewedByManagerId),
          reviewedAt: claim.reviewedAt ?? null,
          customerRespondedAt: claim.customerRespondedAt ?? null,
          awaitingSince: claim.awaitingSince ?? null,
          escalatedSupportCaseId: claim.escalatedSupportCaseId ?? null,
        },
        declined: claim.declinedAt || claim.declinedByTechnicianId
          ? { by: person(claim.declinedByTechnicianId), at: claim.declinedAt ?? null, reasonCode: claim.declineReasonCode ?? null, note: claim.declineNote ?? null }
          : null,
        originalJob: {
          completedAt: order?.completedAt ?? null,
          paymentStatus: invoice?.paymentStatus ?? order?.paymentStatus ?? 'unpaid',
          laborTotal: Number(invoice?.laborTotal ?? order?.laborTotal ?? 0),
          partsTotal: Number(invoice?.partsTotal ?? order?.partsTotal ?? 0),
          grandTotal: Number(invoice?.grandTotal ?? order?.grandTotal ?? 0),
          laborWarrantyDays: order?.laborWarrantyDays ?? null,
          technicians: assignments.map((a) => ({ id: a.technicianId, fullName: person(a.technicianId)?.fullName ?? '', assignedAt: a.assignedAt, isActive: a.isActive })),
          lines: lines.map((l) => ({
            id: l.id, type: l.type, description: l.description, quantity: l.quantity,
            unitPrice: Number(l.unitPrice), lineTotal: Number(l.lineTotal), warrantyDays: l.warrantyDaysSnapshot,
            partSource: l.partSource ?? null, partWarrantyOption: l.partWarrantyOption ?? null,
            covered: coverage?.invoiceItemId === l.id,
            faulty: faultyIds.has(l.id),
            faultyQuantity: faultyIds.has(l.id) ? (faultyQuantities[l.id] ?? l.quantity) : 0,
          })),
        },
        coverage: coverage
          ? {
              id: coverage.id, startsAt: coverage.startsAt, expiresAt: coverage.expiresAt,
              warrantyDays: coverage.warrantyDaysSnapshot, status: effectiveWarrantyStatus(coverage),
            }
          : null,
        visits: visits.map((v) => ({ ...toVisitView(v), technician: person(v.technicianId) })),
        partRequest: request
          ? {
              id: request.id, status: request.status, chargeTechnician: request.chargeTechnician,
              faultyInspectionResult: request.faultyInspectionResult ?? null,
              faultyInspectionNote: request.faultyInspectionNote ?? null,
              faultyInspectionEvidence: request.faultyInspectionEvidence ?? null,
              faultyInspectedAt: request.faultyInspectedAt ?? null,
              faultyReturnDueAt: request.faultyReturnDueAt ?? null,
              faultyReturnedAt: request.faultyReturnedAt ?? null,
              faultyReturnNote: request.faultyReturnNote ?? null,
              faultyReturnEvidence: request.faultyReturnEvidence ?? null,
              faultyReturnChargedAt: request.faultyReturnChargedAt ?? null,
              items: requestItems.map((i) => ({ id: i.id, name: i.partNameSnapshot, quantity: i.quantity, unitPrice: Number(i.unitPriceSnapshot), usageStatus: i.usageStatus })),
            }
          : null,
        otherClaims: others.map((c) => ({ id: c.id, status: c.status, submittedAt: c.submittedAt, itemDescription: lineLabel(c.warrantyCoverageId) })),
      },
    };
  }
}
