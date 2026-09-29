import { WarrantyClaimViewDto, WarrantyVisitViewDto } from './dto/warranty-claim.dto';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { WarrantyVisit } from './entities/warranty-visit.entity';

/** Actor-safe claim view: only id and name of the technician, never contact or account data. */
export function toClaimView(claim: WarrantyClaim): WarrantyClaimViewDto {
  return {
    id: claim.id,
    serviceOrderId: claim.serviceOrderId,
    warrantyCoverageId: claim.warrantyCoverageId,
    status: claim.status,
    description: claim.description,
    evidenceRefs: claim.evidenceRefs ?? null,
    submittedAfterExpiry: claim.submittedAfterExpiry,
    customerResponse: claim.customerResponse ?? null,
    awaitingPrompt: claim.awaitingPrompt ?? null,
    resolutionNotes: claim.resolutionNotes ?? null,
    submittedAt: claim.submittedAt,
    resolvedAt: claim.resolvedAt ?? null,
    technician: claim.technician
      ? { id: claim.technician.id, fullName: claim.technician.fullName }
      : null,
  };
}

export function toVisitView(visit: WarrantyVisit): WarrantyVisitViewDto {
  return {
    id: visit.id,
    status: visit.status,
    scheduledAt: visit.scheduledAt ?? null,
    checkedInAt: visit.checkedInAt ?? null,
    proposedResult: visit.proposedResult ?? null,
    notCoveredReasonCode: visit.notCoveredReasonCode ?? null,
    findings: visit.findings ?? null,
    evidenceRefs: visit.evidenceRefs ?? null,
    reServiceNotes: visit.reServiceNotes ?? null,
    reServiceEvidenceRefs: visit.reServiceEvidenceRefs ?? null,
    completedAt: visit.completedAt ?? null,
  };
}
