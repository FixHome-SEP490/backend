export type ShippingPolicyVersion = 'LEGACY_100_0' | 'W3_70_30_V1';

function wholeVnd(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid whole VND amount');
  return BigInt(value);
}

function checkedVnd(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('VND amount out of range');
  return Number(value);
}

/** Per delivery, round half up in integer VND; technician receives the exact remainder. */
export function calculateShippingShares(
  shippingFee: number,
  policyVersion: ShippingPolicyVersion,
): {
  customerShippingShare: number;
  technicianShippingShare: number;
} {
  const total = wholeVnd(shippingFee);
  if (policyVersion !== 'LEGACY_100_0' && policyVersion !== 'W3_70_30_V1')
    throw new Error('Unknown shipping policy');
  const customer =
    policyVersion === 'LEGACY_100_0' ? total : (total * 7n + 5n) / 10n;
  return {
    customerShippingShare: checkedVnd(customer),
    technicianShippingShare: checkedVnd(total - customer),
  };
}

export interface InvoiceFinancialInput {
  policyVersion: ShippingPolicyVersion;
  shippingFee: number;
  laborTotal: number;
  commissionAmount: number;
  fixHomePartsTotal: number;
  technicianPartsTotal: number;
  technicianPartWarrantyFeeTotal: number;
  knownLaborDeductions: number;
}

export function computeInvoiceFinancialComponents(
  input: InvoiceFinancialInput,
) {
  const shares = calculateShippingShares(
    input.shippingFee,
    input.policyVersion,
  );
  const labor = wholeVnd(input.laborTotal);
  const commission = wholeVnd(input.commissionAmount);
  const fixhome = wholeVnd(input.fixHomePartsTotal);
  const technician = wholeVnd(input.technicianPartsTotal);
  const warranty = wholeVnd(input.technicianPartWarrantyFeeTotal);
  const deductions = wholeVnd(input.knownLaborDeductions);
  const netLabor = checkedVnd(
    labor - commission - BigInt(shares.technicianShippingShare) - deductions,
  );
  const nonlabor = checkedVnd(technician + warranty);
  return Object.freeze({
    ...shares,
    grandTotal: checkedVnd(
      labor +
        fixhome +
        technician +
        warranty +
        BigInt(shares.customerShippingShare),
    ),
    platformDue: checkedVnd(commission + fixhome + wholeVnd(input.shippingFee)),
    netLabor,
    nonlabor,
    technicianPayout: checkedVnd(BigInt(netLabor) + BigInt(nonlabor)),
  });
}
