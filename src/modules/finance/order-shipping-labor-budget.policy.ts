import { calculateShippingShares } from './shipping-finance.policy';

export interface OrderShippingLaborBudgetInput {
  readonly version: 'W3_ORDER_SHIPPING_LABOR_BUDGET_V1';
  readonly serviceOrderId: string;
  readonly laborTotal: number;
  readonly commissionAmount: number;
  readonly knownApprovedDeductions: number;
  readonly deliveryRequestIds: readonly string[];
  readonly deliveries: readonly {
    readonly serviceOrderId: string;
    readonly partRequestId: string;
    readonly quoteVersion: number;
    readonly shippingPolicyVersion: 'W3_70_30_V1';
    readonly shippingFee: number;
    readonly customerShippingShare: number;
    readonly technicianShippingShare: number;
  }[];
}

const fail = (code: string): never => {
  throw new Error(`ORDER_SHIPPING_${code}`);
};
function exact(value: object, keys: readonly string[]): void {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || !('value' in descriptor);
    })
  )
    fail('INVALID_SHAPE');
}
function reference(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:_/-]{0,255}$/.test(value)
  )
    fail('INVALID_REFERENCE');
  return value;
}
function vnd(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_VND');
  return BigInt(value);
}
function checked(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    fail('VND_OUT_OF_RANGE');
  return Number(value);
}

/** Arithmetic ONLY on a complete canonical set supplied by a future trusted DB adapter.
 * Both coverage IDs and immutable quote heads must be read under the same Order lock/CAS.
 * No newest-version selection, deduplication, release inference or unknown-sibling=0 fallback.
 * Include every unresolved spending commitment, even physically RELEASED/invalidated requests;
 * exclusion/replacement needs canonical DB evidence and a separately approved financial lifecycle.
 * A successful result proves neither DB completeness/freshness nor permission to spend/pay out. */
export function assessOrderShippingLaborBudget(
  input: OrderShippingLaborBudgetInput,
): {
  readonly version: 'W3_ORDER_SHIPPING_LABOR_BUDGET_V1';
  readonly serviceOrderId: string;
  readonly deliveryCount: number;
  readonly shippingFee: number;
  readonly customerShippingShare: number;
  readonly technicianShippingShare: number;
  readonly netLaborAfterShipping: number;
  readonly financialExecution: 'BLOCKED';
} {
  exact(input, [
    'version',
    'serviceOrderId',
    'laborTotal',
    'commissionAmount',
    'knownApprovedDeductions',
    'deliveryRequestIds',
    'deliveries',
  ]);
  if (input.version !== 'W3_ORDER_SHIPPING_LABOR_BUDGET_V1')
    fail('INVALID_VERSION');
  const serviceOrderId = reference(input.serviceOrderId);
  const labor = vnd(input.laborTotal);
  const commission = vnd(input.commissionAmount);
  const deductions = vnd(input.knownApprovedDeductions);
  if (
    !Array.isArray(input.deliveryRequestIds) ||
    !Array.isArray(input.deliveries)
  )
    fail('COVERAGE_REQUIRED');
  const expected = new Set<string>();
  for (const id of input.deliveryRequestIds) {
    reference(id);
    if (expected.has(id)) fail('DUPLICATE_DELIVERY');
    expected.add(id);
  }
  const seen = new Set<string>();
  let shipping = 0n,
    customer = 0n,
    technician = 0n;
  for (const delivery of input.deliveries) {
    exact(delivery, [
      'serviceOrderId',
      'partRequestId',
      'quoteVersion',
      'shippingPolicyVersion',
      'shippingFee',
      'customerShippingShare',
      'technicianShippingShare',
    ]);
    const id = reference(delivery.partRequestId);
    if (seen.has(id)) fail('DUPLICATE_DELIVERY');
    seen.add(id);
    if (delivery.serviceOrderId !== serviceOrderId || !expected.has(id))
      fail('SCOPE_OR_COVERAGE_MISMATCH');
    if (
      !Number.isSafeInteger(delivery.quoteVersion) ||
      delivery.quoteVersion < 1
    )
      fail('INVALID_QUOTE_VERSION');
    if (delivery.shippingPolicyVersion !== 'W3_70_30_V1')
      fail('INVALID_POLICY');
    const total = vnd(delivery.shippingFee);
    const c = vnd(delivery.customerShippingShare);
    const t = vnd(delivery.technicianShippingShare);
    const shares = calculateShippingShares(
      delivery.shippingFee,
      delivery.shippingPolicyVersion,
    );
    if (
      c !== BigInt(shares.customerShippingShare) ||
      t !== BigInt(shares.technicianShippingShare)
    )
      fail('SHARE_MISMATCH');
    // Validate each split, then SUM THE STORED SHARES. Never split aggregate S again.
    shipping += total;
    customer += c;
    technician += t;
  }
  if (seen.size !== expected.size) fail('COVERAGE_REQUIRED');
  const shippingFee = checked(shipping);
  const customerShippingShare = checked(customer);
  const technicianShippingShare = checked(technician);
  const net = labor - commission - deductions - technician;
  if (net < 0n) fail('INSUFFICIENT_NET_LABOR');
  return Object.freeze({
    version: input.version,
    serviceOrderId,
    deliveryCount: seen.size,
    shippingFee,
    customerShippingShare,
    technicianShippingShare,
    netLaborAfterShipping: checked(net),
    financialExecution: 'BLOCKED',
  });
}
