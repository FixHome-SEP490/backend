import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DeliveryConsentPreviewService } from './delivery-consent-preview.service';
import { WarehouseDeliveryEvent } from './entities/warehouse-delivery-event.entity';
import { physicalDeliveryBlockers } from './warehouse-delivery.policy';

@Injectable()
export class WarehouseDeliveryPreviewService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(DeliveryConsentPreviewService)
    private readonly owners: DeliveryConsentPreviewService,
  ) {}

  async preview(id: string, actor: { id: string; role: string }) {
    // Reuse B2b DB actor/owner/assignment checks and uniform denial. No additional role access.
    await this.owners.preview(id, actor);
    let cohort: { part_request_id: string } | undefined;
    let head: WarehouseDeliveryEvent | null;
    try {
      [cohort] = await this.dataSource.manager.query(
        'SELECT part_request_id FROM warehouse_delivery_cohorts WHERE part_request_id=$1',
        [id],
      );
      head = cohort
        ? await this.dataSource.manager.findOne(WarehouseDeliveryEvent, {
            where: { partRequestId: id },
            order: { resultVersion: 'DESC' },
          })
        : null;
    } catch {
      throw new ServiceUnavailableException(
        'Chưa thể đọc điều kiện giao linh kiện. Vui lòng thử lại sau.',
      );
    }
    // Reject observed revocation before returning the projection. Still NON_ATOMIC, never authority.
    const facts = await this.owners.preview(id, actor);
    const ineligible =
      facts.source.partsLaborApproval !== 'VERIFIED_APPROVED' ||
      facts.blockers.some((b) =>
        [
          'ORDER_FROZEN',
          'ORDER_INVOICED',
          'REQUEST_FROZEN',
          'REQUEST_KIND_UNSUPPORTED',
          'FULFILLMENT_NOT_DELIVERY',
          'SOURCE_BINDING_UNVERIFIED',
          'PARTS_LABOR_SOURCE_NOT_APPROVED',
        ].includes(b),
      );
    return {
      mode: 'NON_EXECUTABLE_PREVIEW' as const,
      consistency: 'NON_ATOMIC' as const,
      requestId: id,
      eligibility:
        cohort && !ineligible
          ? ('PENDING_ASSISTANCE' as const)
          : ('INELIGIBLE' as const),
      reason: !cohort
        ? 'LEGACY_OR_NOT_ENROLLED'
        : ineligible
          ? 'SCOPE_OR_PARTS_SOURCE_UNVERIFIED'
          : 'SHIPPING_APPROVAL_SOURCE_UNVERIFIED',
      lastAssessment: head
        ? {
            version: head.resultVersion,
            status: head.snapshot.status,
            reason: head.snapshot.reason,
          }
        : null,
      physicalExecution: 'BLOCKED' as const,
      financialExecution: 'BLOCKED' as const,
      evidence: head?.snapshot.evidence.length
        ? ('RECORDED_NOT_EXTERNALLY_VERIFIED' as const)
        : ('NOT_RECORDED' as const),
      actualCourierCost: null,
      courierPayment: 'NOT_RECORDED' as const,
      blockers: [...new Set([...facts.blockers, ...physicalDeliveryBlockers])],
      actions: {
        reserve: 'BLOCKED',
        issueToCourier: 'BLOCKED',
        dispatch: 'BLOCKED',
        technicianReceipt: 'BLOCKED',
      } as const,
    };
  }
}
