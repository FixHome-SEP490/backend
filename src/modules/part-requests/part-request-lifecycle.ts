import { EntityManager, In } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { PartRequestStatus, PartRequestType, PartSource, PartUsageStatus } from '../../shared/enums';
import { PartRequest } from './entities/part-request.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';

/** Caller holds the Service Order write lock, also acquired by every parts mutation. */
export async function closeOrderPartRequests(manager: EntityManager, orderId: string, cancelled: boolean): Promise<void> {
  // On completion only the finishing technician's received parts are settled.
  // Parts a replaced technician picked up stay RECEIVED, so the warehouse still
  // sees them as not returned.
  const holder = cancelled ? null : await manager.findOneBy(TechnicianAssignment, { serviceOrderId: orderId, isActive: true });
  await manager.update(PartRequest, {
    serviceOrderId: orderId,
    ...(holder ? { technicianId: holder.technicianId } : {}),
    status: In(cancelled
      ? [PartRequestStatus.REQUESTED, PartRequestStatus.READY, PartRequestStatus.DELIVERING, PartRequestStatus.RECEIVED]
      : [PartRequestStatus.RECEIVED]),
  }, cancelled
    ? { status: PartRequestStatus.CANCELLED, cancelledAt: new Date(), qrToken: null }
    : { status: PartRequestStatus.COMPLETED, completedAt: new Date(), qrToken: null });
}

/**
 * A technician leaving an order before arrival (withdrawal, staff override,
 * reschedule) gives up the part requests nobody has picked up yet, so the
 * replacement can file their own. Parts already received stay with the
 * request for the warehouse to recover.
 */
export async function releaseOutgoingTechnicianPartRequests(manager: EntityManager, orderId: string, technicianId: string): Promise<void> {
  await manager.update(PartRequest, {
    serviceOrderId: orderId,
    technicianId,
    status: In([PartRequestStatus.REQUESTED, PartRequestStatus.READY, PartRequestStatus.DELIVERING]),
  }, { status: PartRequestStatus.CANCELLED, cancelledAt: new Date(), qrToken: null });
}

/** The requests that gate completion: those of the technician holding the order. */
export async function holderPartRequests(manager: EntityManager, orderId: string, requests?: PartRequest[]): Promise<PartRequest[]> {
  const all = requests ?? await manager.find(PartRequest, { where: { serviceOrderId: orderId }, relations: ['items'] });
  const holder = await manager.findOneBy(TechnicianAssignment, { serviceOrderId: orderId, isActive: true });
  return holder ? all.filter(request => request.technicianId === holder.technicianId) : all;
}

export function assertPartsResolved(requests: PartRequest[]): void {
  if (requests.some(r => r.status !== PartRequestStatus.CANCELLED &&
    (!([PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED].includes(r.status)) ||
      r.items.some(i => i.usageStatus === PartUsageStatus.PENDING)))) {
    throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Receive or cancel outstanding parts requests and record USED/RETURNED before completion');
  }
}

/** Resolve only explicit request types; quotation stock must match the approved quotation. */
export function partRequestCostSource(request: PartRequest, quotationId?: string | null): string | null {
  if (request.requestType === PartRequestType.PRE_REPAIR) return 'quotation';
  if (request.requestType === PartRequestType.QUOTATION) {
    return request.quotationId && (quotationId === undefined || request.quotationId === quotationId) && !request.additionalCostId ? 'quotation' : null;
  }
  return request.requestType === PartRequestType.ADDITIONAL ? request.additionalCostId ?? null : null;
}

export interface ApprovedPartLine {
  source: string;
  partSource?: PartSource | null;
  partCatalogId?: string | null;
  quantity: number;
}

/**
 * Units of a FixHome part delivered for the quotation (PRE_REPAIR or the linked QUOTATION
 * request) beyond what the quotation approved: the technician still holds them, and an
 * approved additional cost may use them instead of a new request (BUG DETECTOR 14). Each
 * additional cost first uses the units of its own request; only the shortfall comes from here.
 */
export function quotationSurplus(approvedBase: number, deliveredBase: number): number {
  return Math.max(0, deliveredBase - approvedBase);
}

/** Missing warehouse evidence is not a discount. A resolved return is a legitimate exclusion. */
export function assertApprovedPartsResolved(lines: ApprovedPartLine[], requests: PartRequest[], quotationId: string | null, custodyUsage: ReadonlyMap<string, number> = new Map()): void {
  const approved = new Map<string, number>();
  const resolved = new Map<string, number>();
  const used = new Map<string, number>();
  const key = (source: string, catalogId: string) => `${source}:${catalogId}`;
  const fail = () => { throw new BusinessException(ErrorCodes.CONFLICT, 'Linh kiện chưa khớp báo giá và bàn giao. Vui lòng liên hệ FixHome để kiểm tra hóa đơn.'); };
  for (const line of lines) {
    if (line.partSource !== PartSource.FIXHOME) continue;
    if (!line.partCatalogId || !Number.isSafeInteger(line.quantity) || line.quantity < 1) fail();
    const k = key(line.source, line.partCatalogId!);
    approved.set(k, (approved.get(k) ?? 0) + line.quantity);
  }
  for (const request of requests) {
    if (![PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED].includes(request.status)) continue;
    const source = partRequestCostSource(request, quotationId);
    if (!source) {
      if (request.items.some(i => i.partSource === PartSource.FIXHOME && i.usageStatus === PartUsageStatus.USED)) fail();
      continue;
    }
    for (const item of request.items) {
      if (item.partSource !== PartSource.FIXHOME || !item.partCatalogId) continue;
      if (![PartUsageStatus.USED, PartUsageStatus.RETURNED].includes(item.usageStatus)) continue;
      const k = key(source, item.partCatalogId);
      resolved.set(k, (resolved.get(k) ?? 0) + item.quantity);
      const quantity = item.usageStatus === PartUsageStatus.USED ? custodyUsage.get(item.id) ?? item.quantity : 0;
      if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > item.quantity) fail();
      used.set(k, (used.get(k) ?? 0) + quantity);
    }
  }
  // An additional cost short of its own supply leans on the quotation's surplus, per part.
  const surplusNeeded = new Map<string, { resolved: number; used: number }>();
  for (const [k, quantity] of approved) {
    const [source, catalogId] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    if (source === 'quotation') continue;
    const need = surplusNeeded.get(catalogId) ?? { resolved: 0, used: 0 };
    need.resolved += Math.max(0, quantity - (resolved.get(k) ?? 0));
    need.used += Math.max(0, quantity - (used.get(k) ?? 0));
    surplusNeeded.set(catalogId, need);
  }
  for (const [k, quantity] of approved) {
    const [source, catalogId] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    if (source === 'quotation' && (resolved.get(k) ?? 0) < quantity + (surplusNeeded.get(catalogId)?.resolved ?? 0)) fail();
  }
  for (const [catalogId, need] of surplusNeeded) {
    const base = key('quotation', catalogId);
    if (!approved.has(base) && (resolved.get(base) ?? 0) < need.resolved) fail();
  }
  for (const [k, quantity] of used) {
    const [source, catalogId] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    const allowance = (approved.get(k) ?? 0) + (source === 'quotation' ? surplusNeeded.get(catalogId)?.used ?? 0 : 0);
    if (quantity > allowance) fail();
  }
}

/**
 * Consume each received USED quantity once, within its approved cost source. With the
 * approved lines, an additional cost short of its own used units takes the quotation's
 * surplus (used beyond the quotation's approval), whatever order the lines are billed in.
 */
export function usedPartQuantities(requests: PartRequest[], custodyUsage: ReadonlyMap<string, number> = new Map(), quotationId?: string | null, approvedLines: ApprovedPartLine[] = []) {
  const quantities = new Map<string, number>();
  const key = (source: string, catalogId: string) => `${source}:${catalogId}`;
  for (const request of requests) {
    if (![PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED].includes(request.status)) continue;
    const source = partRequestCostSource(request, quotationId);
    if (!source) continue;
    for (const item of request.items) {
      if (item.partSource !== PartSource.FIXHOME || item.usageStatus !== PartUsageStatus.USED || !item.partCatalogId) continue;
      const itemKey = key(source, item.partCatalogId);
      quantities.set(itemKey, (quantities.get(itemKey) || 0) + (custodyUsage.get(item.id) ?? item.quantity));
    }
  }
  const surplus = new Map<string, number>();
  const approvedBase = new Map<string, number>();
  for (const line of approvedLines) {
    if (line.source === 'quotation' && line.partSource === PartSource.FIXHOME && line.partCatalogId) {
      approvedBase.set(line.partCatalogId, (approvedBase.get(line.partCatalogId) ?? 0) + line.quantity);
    }
  }
  if (approvedLines.length) {
    for (const [itemKey, usedQty] of quantities) {
      if (!itemKey.startsWith('quotation:')) continue;
      const catalogId = itemKey.slice('quotation:'.length);
      surplus.set(catalogId, quotationSurplus(approvedBase.get(catalogId) ?? 0, usedQty));
    }
  }
  return (source: string, item: { partSource?: PartSource | null; partCatalogId?: string | null; quantity: number }): number => {
    if (item.partSource !== PartSource.FIXHOME) return item.quantity;
    const catalogId = item.partCatalogId || '';
    const itemKey = key(source, catalogId);
    const baseKey = key('quotation', catalogId);
    const reserved = surplus.get(catalogId) ?? 0;
    // The quotation never bills the surplus kept for additional costs.
    const available = (quantities.get(itemKey) || 0) - (source === 'quotation' ? reserved : 0);
    let billed = Math.min(item.quantity, Math.max(0, available));
    quantities.set(itemKey, (quantities.get(itemKey) || 0) - billed);
    if (source !== 'quotation' && billed < item.quantity && reserved > 0) {
      const fromSurplus = Math.min(item.quantity - billed, reserved);
      surplus.set(catalogId, reserved - fromSurplus);
      quantities.set(baseKey, (quantities.get(baseKey) || 0) - fromSurplus);
      billed += fromSurplus;
    }
    return billed;
  };
}
