import { PartSource } from '../../shared/enums';
import {
  canonicalWarehouseQuantities,
  hasWholeRequestStock,
  WarehouseQuantity,
} from './warehouse-fulfillment.rules';

export type DeliveryStockFacts = {
  fresh: boolean;
  delivery: boolean;
  approved: boolean;
  open: boolean;
  consentVerified: boolean;
  shippingApproved: boolean;
  items: {
    partCatalogId?: string | null;
    partSource: string;
    quantity: number;
  }[];
  warehouses: { id: string; responsibleUserId: string }[];
  stocks: {
    warehouseId: string;
    partId: string;
    onHand: number;
    reserved: number;
  }[];
};
export type DeliveryAssessment = {
  status: 'INELIGIBLE' | 'PENDING_ASSISTANCE' | 'RESERVED';
  reason: string | null;
  warehouseId: string | null;
  responsibleUserId: string | null;
  quantities: WarehouseQuantity[];
};
export type CourierMetadata = {
  courierReference: string;
  evidenceRef: string;
  contentDigest: string;
};
export type PhysicalCommandKind =
  | 'RESERVE'
  | 'RELEASE'
  | 'ISSUE_TO_COURIER'
  | 'COURIER_DISPATCH'
  | 'TECHNICIAN_RECEIPT';
export type DeliveryPhysicalState = Omit<DeliveryAssessment, 'status'> & {
  status:
    | DeliveryAssessment['status']
    | 'RELEASED'
    | 'ISSUED_TO_COURIER'
    | 'DISPATCH_RECORDED'
    | 'TECHNICIAN_RECEIVED';
  version: number;
  courierReference: string | null;
  evidence: (CourierMetadata & {
    kind: PhysicalCommandKind;
    verification: 'RECORDED_NOT_EXTERNALLY_VERIFIED';
  })[];
};
export const physicalDeliveryBlockers = [
  'PHYSICAL_ACTIVATION_CLOSED',
  'SHIPPING_APPROVAL_SOURCE_UNVERIFIED',
  'DUAL_CONSENT_UNVERIFIED',
  'FINANCE_CUTOVER_CLOSED',
] as const;

/** Pure stock decision, NOT an authority adapter. Only server-loaded facts may enter mutations. */
export function assessDeliveryStock(f: DeliveryStockFacts): DeliveryAssessment {
  const blocked = (
    status: 'INELIGIBLE' | 'PENDING_ASSISTANCE',
    reason: string,
  ): DeliveryAssessment => ({
    status,
    reason,
    warehouseId: null,
    responsibleUserId: null,
    quantities: [],
  });
  if (!f.fresh) return blocked('INELIGIBLE', 'LEGACY_REQUEST');
  if (!f.delivery) return blocked('INELIGIBLE', 'NOT_DELIVERY');
  if (!f.open) return blocked('INELIGIBLE', 'SCOPE_FROZEN');
  if (!f.approved) return blocked('INELIGIBLE', 'PARTS_SOURCE_UNVERIFIED');
  let quantities: WarehouseQuantity[];
  try {
    quantities = canonicalWarehouseQuantities(
      f.items as {
        partCatalogId?: string | null;
        partSource: PartSource;
        quantity: number;
      }[],
    );
  } catch {
    return blocked('INELIGIBLE', 'FIXHOME_ITEMS_REQUIRED');
  }
  if (!f.shippingApproved)
    return blocked('PENDING_ASSISTANCE', 'SHIPPING_APPROVAL_SOURCE_UNVERIFIED');
  if (!f.consentVerified)
    return blocked('PENDING_ASSISTANCE', 'DUAL_CONSENT_UNVERIFIED');
  const chosen = [...f.warehouses]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .find((w) =>
      hasWholeRequestStock(
        quantities,
        f.stocks.filter(
          (s) =>
            s.warehouseId === w.id &&
            Number.isInteger(s.onHand) &&
            Number.isInteger(s.reserved) &&
            s.reserved >= 0 &&
            s.onHand >= s.reserved &&
            s.onHand <= 2147483647,
        ),
      ),
    );
  if (!chosen) return blocked('PENDING_ASSISTANCE', 'NO_SINGLE_WAREHOUSE');
  return {
    status: 'RESERVED',
    reason: null,
    warehouseId: chosen.id,
    responsibleUserId: chosen.responsibleUserId,
    quantities,
  };
}

export function advanceDelivery(
  state: DeliveryPhysicalState,
  kind: Exclude<PhysicalCommandKind, 'RESERVE'>,
  metadata: CourierMetadata | null,
): DeliveryPhysicalState {
  if (
    !Number.isInteger(state.version) ||
    state.version < 1 ||
    state.version >= 2147483647
  )
    throw new Error('DELIVERY_VERSION_CONFLICT');
  if (kind === 'RELEASE') {
    if (state.status !== 'RESERVED')
      throw new Error('DELIVERY_RELEASE_FORBIDDEN');
    if (metadata !== null) throw new Error('DELIVERY_EVIDENCE_INVALID');
    return { ...state, version: state.version + 1, status: 'RELEASED' };
  }
  const from = {
    ISSUE_TO_COURIER: 'RESERVED',
    COURIER_DISPATCH: 'ISSUED_TO_COURIER',
    TECHNICIAN_RECEIPT: 'DISPATCH_RECORDED',
  };
  const to = {
    ISSUE_TO_COURIER: 'ISSUED_TO_COURIER',
    COURIER_DISPATCH: 'DISPATCH_RECORDED',
    TECHNICIAN_RECEIPT: 'TECHNICIAN_RECEIVED',
  } as const;
  if (
    state.status !== from[kind] ||
    !state.warehouseId ||
    !state.quantities.length
  )
    throw new Error('DELIVERY_TRANSITION_FORBIDDEN');
  if (
    !metadata ||
    Object.getPrototypeOf(metadata) !== Object.prototype ||
    Object.getOwnPropertySymbols(metadata).length ||
    Object.keys(metadata).sort().join(',') !==
      'contentDigest,courierReference,evidenceRef' ||
    typeof metadata.courierReference !== 'string' ||
    typeof metadata.evidenceRef !== 'string' ||
    typeof metadata.contentDigest !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(metadata.courierReference) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(metadata.evidenceRef) ||
    !/^[a-f0-9]{64}$/.test(metadata.contentDigest) ||
    state.evidence.some((e) => e.evidenceRef === metadata.evidenceRef) ||
    (state.courierReference !== null &&
      state.courierReference !== metadata.courierReference)
  )
    throw new Error('DELIVERY_EVIDENCE_INVALID');
  return {
    ...state,
    version: state.version + 1,
    status: to[kind],
    courierReference: metadata.courierReference,
    evidence: [
      ...state.evidence,
      { ...metadata, kind, verification: 'RECORDED_NOT_EXTERNALLY_VERIFIED' },
    ],
  };
}
