import { EntityManager, In } from 'typeorm';
import { SupportCaseStatus } from '../../shared/enums';
import { SupportCase } from './entities/support-case.entity';

/** True while a manager asked to stop this order from completing automatically. */
export async function isCompletionHeld(manager: EntityManager, orderId: string): Promise<boolean> {
  const held = await manager.count(SupportCase, {
    where: {
      serviceOrderId: orderId,
      holdCompletion: true,
      status: In([SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW]),
    },
  });
  return held > 0;
}
