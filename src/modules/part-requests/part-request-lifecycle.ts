import { EntityManager, In } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { PartRequestStatus, PartRequestType, PartSource, PartUsageStatus } from '../../shared/enums';
import { PartRequest } from './entities/part-request.entity';

/** Caller holds the Service Order write lock, also acquired by every parts mutation. */
export async function closeOrderPartRequests(manager: EntityManager, orderId: string, cancelled: boolean): Promise<void> {
  await manager.update(PartRequest, {
    serviceOrderId: orderId,
    status: In(cancelled
      ? [PartRequestStatus.REQUESTED, PartRequestStatus.READY, PartRequestStatus.DELIVERING, PartRequestStatus.RECEIVED]
      : [PartRequestStatus.RECEIVED]),
  }, cancelled
    ? { status: PartRequestStatus.CANCELLED, cancelledAt: new Date(), qrToken: null }
    : { status: PartRequestStatus.COMPLETED, completedAt: new Date(), qrToken: null });
}

export function assertPartsResolved(requests: PartRequest[]): void {
  if (requests.some(r => r.status !== PartRequestStatus.CANCELLED &&
    (!([PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED].includes(r.status)) ||
      r.items.some(i => i.usageStatus === PartUsageStatus.PENDING)))) {
    throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Receive or cancel outstanding parts requests and record USED/RETURNED before completion');
  }
}

/** Consume each received USED quantity once, within its approved cost source. */
export function usedPartQuantities(requests: PartRequest[]) {
  const quantities = new Map<string, number>();
  const key = (source: string, catalogId: string) => `${source}:${catalogId}`;
  for (const request of requests) {
    if (![PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED].includes(request.status)) continue;
    const source = request.requestType === PartRequestType.PRE_REPAIR ? 'quotation' : request.additionalCostId;
    if (!source) continue;
    for (const item of request.items) {
      if (item.partSource !== PartSource.FIXHOME || item.usageStatus !== PartUsageStatus.USED || !item.partCatalogId) continue;
      const itemKey = key(source, item.partCatalogId);
      quantities.set(itemKey, (quantities.get(itemKey) || 0) + item.quantity);
    }
  }
  return (source: string, item: { partSource?: PartSource | null; partCatalogId?: string | null; quantity: number }): number => {
    if (item.partSource !== PartSource.FIXHOME) return item.quantity;
    const itemKey = key(source, item.partCatalogId || '');
    const available = quantities.get(itemKey) || 0;
    const billed = Math.min(item.quantity, available);
    quantities.set(itemKey, available - billed);
    return billed;
  };
}
