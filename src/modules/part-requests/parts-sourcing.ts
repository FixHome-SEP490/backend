import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { QuotationItem } from '../quotations/entities/quotation-item.entity';

/** The fields of a quotation or additional-cost line that decide its FixHome part supply. */
export type SourcingLine = Pick<QuotationItem, 'type' | 'partSource' | 'partCatalogId' | 'quantity' | 'unitPrice' | 'partNameSnapshot' | 'description'>;
export type MissingPart = { partCatalogId: string; name: string; quantity: number };
export type PartsSourcing = { status: 'none' | 'covered' | 'available' | 'unavailable'; missing: MissingPart[] };

export const PARTS_SOURCE_UNAVAILABLE_MESSAGE =
  'Chưa có kho FixHome nào đủ linh kiện trong báo giá nên chưa duyệt được. Kỹ thuật viên cần lập lại báo giá hoặc chờ kho bổ sung rồi duyệt lại.';

/**
 * F3 (TECH 66, CUSTOMER 72): an approval whose FixHome parts no warehouse can supply. Thrown
 * inside the approval transaction so nothing of the approval is kept (quote stays SENT, cost
 * stays pending); the parts are never treated as supplied and no outside part charge appears.
 */
export function partsSourceUnavailable(missing: MissingPart[]): BusinessException {
  return new BusinessException(ErrorCodes.PARTS_SOURCE_UNAVAILABLE, PARTS_SOURCE_UNAVAILABLE_MESSAGE, { missing });
}

export function isPartsSourceUnavailable(error: unknown): boolean {
  const response = (error as { getResponse?: () => unknown })?.getResponse?.();
  return !!response && typeof response === 'object' && (response as { code?: string }).code === ErrorCodes.PARTS_SOURCE_UNAVAILABLE;
}
