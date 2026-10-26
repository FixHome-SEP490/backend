import type { EntityManager } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { Role, ServiceOrderStatus, SupportCaseType } from '../../shared/enums';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import type { ServiceOrder } from './entities/service-order.entity';
import { REPAIR_FAILURE_REASONS, type RepairFailedDto } from './dto/repair-failed.dto';

export const REPAIR_FAILURE_ACTION = 'VISIT_DEVICE_REPAIR_FAILED';

/** Stable comparison for a retry, independent of photo/part selection order. */
export function repairFailureRequest(dto: RepairFailedDto) {
  const parts = dto.parts ?? [];
  const photos = dto.photoEvidenceIds ?? [];
  if (!Object.prototype.hasOwnProperty.call(REPAIR_FAILURE_REASONS, dto.reason) ||
      (dto.note != null && (typeof dto.note !== 'string' || dto.note.length > 500)) ||
      !Array.isArray(parts) || parts.length > 20 ||
      parts.some(p => !p || typeof p.partRequestId !== 'string' || !p.partRequestId || !['installed', 'returned'].includes(p.outcome)) ||
      new Set(parts.map(p => p.partRequestId)).size !== parts.length ||
      !Array.isArray(photos) || photos.length > 3 || new Set(photos).size !== photos.length || photos.some(id => typeof id !== 'string')) {
    throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Chọn lý do và tối đa 3 ảnh hợp lệ, không trùng nhau.');
  }
  return {
    reason: dto.reason,
    note: dto.note?.trim() || null,
    parts: parts.map(p => ({ partRequestId: p.partRequestId, outcome: p.outcome })).sort((a, b) => a.partRequestId.localeCompare(b.partRequestId)),
    photoEvidenceIds: [...photos].sort(),
  };
}

/**
 * A generic cancellation or raw incident prose is never a failed-repair source.
 * The receipt is written strictly in the same transaction under the order lock.
 * Legacy reports without a linked receipt require explicit reconciliation.
 */
export async function repairFailureIncident(manager: EntityManager, order: ServiceOrder): Promise<{ incident: SupportCase; request: ReturnType<typeof repairFailureRequest> } | null> {
  if (order.status !== ServiceOrderStatus.CANCELLED) return null;
  const receipts = await manager.find(AuditLog, { where: { action: REPAIR_FAILURE_ACTION, resourceType: 'service_order', resourceId: order.id } });
  if (receipts.length !== 1) return null;
  const receipt = receipts[0];
  if (receipt.actorRole !== Role.TECHNICIAN || receipt.after?.version !== 1 || typeof receipt.after.incidentId !== 'string' || !receipt.after.request) return null;
  let request: ReturnType<typeof repairFailureRequest>;
  try {
    // jsonb does not preserve object key order; rebuild a validated canonical
    // request before comparing retries. Malformed receipts grant no authority.
    const stored = receipt.after.request as RepairFailedDto;
    if (!Array.isArray(stored.parts) || !Array.isArray(stored.photoEvidenceIds) || !Object.prototype.hasOwnProperty.call(stored, 'note')) return null;
    request = repairFailureRequest(stored);
  } catch { return null; }
  const incident = await manager.findOneBy(SupportCase, {
    id: receipt.after.incidentId, serviceOrderId: order.id, bookingId: order.bookingId,
    caseType: SupportCaseType.MID_JOB_INTERRUPTION,
  });
  if (!incident || !incident.technicianId || incident.createdByUserId !== receipt.actorUserId || incident.technicianId !== receipt.actorUserId) return null;
  return { incident, request };
}
