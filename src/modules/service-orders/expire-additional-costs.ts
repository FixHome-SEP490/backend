import { EntityManager, LessThanOrEqual } from 'typeorm';
import { AdditionalCostRequest } from './entities/additional-cost-request.entity';
import { AdditionalCostStatus } from '../../shared/enums';

/** Caller holds the order lock, also used by approval. Expiration never approves work. */
export async function expireAdditionalCosts(manager: EntityManager, orderId: string): Promise<void> {
  await manager.update(AdditionalCostRequest, {
    serviceOrderId: orderId,
    status: AdditionalCostStatus.PENDING_APPROVAL,
    expiresAt: LessThanOrEqual(new Date()),
  }, { status: AdditionalCostStatus.EXPIRED });
}
