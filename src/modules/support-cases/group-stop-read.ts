import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { ONSITE_INTERRUPTION_ACTION } from '../service-orders/onsite-interruption';
import type { SupportCase } from './entities';

/** Additive correlation for the existing staff queue/detail; case text is never authority. */
export async function groupStopCorrelations(manager: EntityManager, cases: SupportCase[]) {
  const result = new Map<string, { groupId: string; commandId: string; incidentPath: string; childCaseIds: string[]; financialFollowupRequired: true }>();
  const orderIds = cases.map(c => c.serviceOrderId).filter((id): id is string => !!id);
  if (!orderIds.length) return result;
  const receipts = await manager.find(AuditLog, { where: { action: ONSITE_INTERRUPTION_ACTION,
    resourceType: 'service_order', resourceId: In(orderIds) } });
  const groupIds = receipts.map(row => row.after?.sourceVisitGroupId).filter((id): id is string => typeof id === 'string');
  if (!groupIds.length) return result;
  const groups = await manager.find(AuditLog, { where: { action: 'VISIT_GROUP_STOPPED', resourceType: 'visit_group', resourceId: In(groupIds) } });
  for (const c of cases) {
    const receipt = receipts.find(row => row.resourceId === c.serviceOrderId && row.after?.incidentId === c.id);
    const group = receipt && groups.find(row => row.resourceId === receipt.after?.sourceVisitGroupId &&
      row.after?.commandId === receipt.after?.groupCommandId && row.actorUserId === receipt.actorUserId);
    const outcome = group?.after?.result as { stopped?: Array<{ incidentId?: string }> } | undefined;
    const childCaseIds = outcome?.stopped?.map(child => child.incidentId).filter((id): id is string => typeof id === 'string');
    if (!group?.resourceId || typeof group.after?.commandId !== 'string' || !childCaseIds?.includes(c.id)) continue;
    result.set(c.id, { groupId: group.resourceId, commandId: group.after.commandId,
      incidentPath: `/api/v1/visit-groups/${group.resourceId}/stop-incidents`, childCaseIds, financialFollowupRequired: true });
  }
  return result;
}
