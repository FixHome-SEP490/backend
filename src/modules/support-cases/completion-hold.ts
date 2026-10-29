import { EntityManager, In } from 'typeorm';
import { SupportCaseStatus } from '../../shared/enums';
import { SupportCase } from './entities/support-case.entity';
import { ONSITE_INTERRUPTION_ACTION } from '../service-orders/onsite-interruption';
import { AuditLog } from '../audit-log/entities/audit-log.entity';

/** Case hold or durable onsite interruption, independently of later SM case status. */
export async function isCompletionHeld(manager: EntityManager, orderId: string): Promise<boolean> {
  const held = await manager.count(SupportCase, {
    where: {
      serviceOrderId: orderId,
      holdCompletion: true,
      status: In([SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW]),
    },
  });
  return held > 0 || await manager.count(AuditLog, { where: {
    action: ONSITE_INTERRUPTION_ACTION, resourceType: 'service_order', resourceId: orderId,
  } }) > 0;
}
