import { ConflictException } from '@nestjs/common';

export interface CashIntentAllocation {
  invoiceId: string;
  serviceOrderId: string;
  originalGrossVnd: number;
  customerDueVnd: number;
}

export interface CashReceiptIntent {
  customerId: string;
  technicianId: string;
  status: string;
  grossVnd: number;
  customerDueVnd: number;
  allocations: CashIntentAllocation[];
}

export function assertCashReceiptMatchesIntent(
  intent: CashReceiptIntent,
  technicianId: string,
  receivedAmountVnd: number,
  allocations: CashIntentAllocation[],
): void {
  const validAmount = (amount: number) => Number.isSafeInteger(amount) && amount >= 0;
  const same = (left: CashIntentAllocation[], right: CashIntentAllocation[]) => {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return false;
    if ([...left, ...right].some(item => !item || typeof item.invoiceId !== 'string' ||
      typeof item.serviceOrderId !== 'string')) return false;
    const sorted = (items: CashIntentAllocation[]) => [...items].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
    const a = sorted(left);
    const b = sorted(right);
    return a.every((item, index) => item && b[index] && item.invoiceId === b[index].invoiceId &&
      item.serviceOrderId === b[index].serviceOrderId &&
      item.originalGrossVnd === b[index].originalGrossVnd &&
      item.customerDueVnd === b[index].customerDueVnd &&
      validAmount(item.originalGrossVnd) && validAmount(item.customerDueVnd) &&
      item.customerDueVnd <= item.originalGrossVnd &&
      (index === 0 || item.invoiceId !== a[index - 1].invoiceId));
  };
  if (intent.status !== 'pending' || intent.technicianId !== technicianId ||
      !validAmount(intent.grossVnd) || !validAmount(intent.customerDueVnd) ||
      !validAmount(receivedAmountVnd) || receivedAmountVnd <= 0 ||
      receivedAmountVnd !== intent.customerDueVnd ||
      !same(intent.allocations, allocations) ||
      intent.allocations.reduce((sum, item) => sum + item.originalGrossVnd, 0) !== intent.grossVnd ||
      intent.allocations.reduce((sum, item) => sum + item.customerDueVnd, 0) !== intent.customerDueVnd) {
    throw new ConflictException('Thông tin tiền mặt đã thay đổi. Vui lòng kiểm tra lại.');
  }
}
