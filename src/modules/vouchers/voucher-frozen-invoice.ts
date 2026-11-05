import type { Invoice } from '../service-orders/entities/invoice.entity';
import { assertShippingFinancialCutoverAllowed } from '../finance/invoice-shipping-snapshot';
import { readInvoiceFinancialSnapshot } from '../finance/invoice-financial-snapshot';
import type { InvoiceItem } from '../service-orders/entities/invoice-item.entity';
import type { VoucherFundingInvoiceFacts } from './voucher-funding.types';
import { ConflictException } from '@nestjs/common';
import { CostItemType, PartSource, PaymentStatus } from '../../shared/enums';

export interface VoucherApprovedPartSource {
  id: string;
  serviceOrderId: string;
  approved: boolean;
  partCatalogId?: string | null;
  partSource?: string | null;
  type: string;
  unitPrice: number;
  quantity: number;
}

export function frozenVoucherInvoiceFacts(
  invoice: Invoice,
  items: readonly InvoiceItem[],
  approvedParts: ReadonlyMap<string, VoucherApprovedPartSource>,
): VoucherFundingInvoiceFacts {
  assertShippingFinancialCutoverAllowed(invoice);
  const vnd = (value: unknown): number => {
    if (typeof value !== 'number' &&
        !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) {
      throw new ConflictException('Dữ liệu hóa đơn ưu đãi không nhất quán.');
    }
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 0 || value === null || value === undefined || value === '') {
      throw new ConflictException('Dữ liệu hóa đơn ưu đãi không nhất quán.');
    }
    return amount;
  };
  const financial = readInvoiceFinancialSnapshot(invoice);
  const { grandTotal: gross, laborTotal: labor, fixHomePartsTotal: fixHomeParts,
    technicianPartsTotal: technicianParts, commissionAmount: commission } = financial;
  const rate = Number(invoice.commissionRateSnapshot);
  if (invoice.paymentStatus !== PaymentStatus.UNPAID || !Number.isFinite(rate) || rate < 0 || rate > 1 ||
      commission !== Math.round(labor * rate) || !Array.isArray(items)) {
    throw new ConflictException('Dữ liệu hóa đơn ưu đãi không nhất quán.');
  }

  let resolvedFixHome = 0;
  let resolvedLabor = 0;
  let resolvedOtherParts = 0;
  const resolvedItems = items.map((item) => {
    if (item.invoiceId !== invoice.id || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
        vnd(item.lineTotal) !== item.quantity * vnd(item.unitPrice)) {
      throw new ConflictException('Dòng hóa đơn ưu đãi không nhất quán.');
    }
    if (item.type !== CostItemType.LABOR && item.type !== CostItemType.PARTS_EQUIPMENT) {
      throw new ConflictException('Loại dòng hóa đơn ưu đãi không hợp lệ.');
    }
    let partCatalogId: string | null = null;
    if (item.type === CostItemType.LABOR) resolvedLabor += vnd(item.lineTotal);
    if (item.type === CostItemType.PARTS_EQUIPMENT && item.partSource === PartSource.FIXHOME) {
      const source = item.sourceItemId && approvedParts.get(`${item.sourceType}:${item.sourceItemId}`);
      if (!source || source.id !== item.sourceItemId || source.serviceOrderId !== invoice.serviceOrderId ||
          source.approved !== true || source.type !== item.type ||
          source.partSource !== PartSource.FIXHOME || !source.partCatalogId ||
          !Number.isSafeInteger(source.quantity) || source.quantity <= 0 ||
          item.quantity > source.quantity || vnd(source.unitPrice) !== vnd(item.unitPrice)) {
        throw new ConflictException('Linh kiện FixHome thiếu nguồn duyệt hợp lệ.');
      }
      partCatalogId = source.partCatalogId;
      resolvedFixHome += vnd(item.lineTotal);
    } else if (item.type === CostItemType.PARTS_EQUIPMENT) {
      if (item.partSource !== PartSource.TECHNICIAN && item.partSource !== PartSource.EXTERNAL) {
        throw new ConflictException('Nguồn linh kiện hóa đơn không hợp lệ.');
      }
      resolvedOtherParts += vnd(item.lineTotal);
    }
    return {
      invoiceId: item.invoiceId,
      type: item.type,
      partSource: item.partSource,
      partCatalogId,
      quantity: item.quantity,
      unitPriceVnd: vnd(item.unitPrice),
      lineTotalVnd: vnd(item.lineTotal),
    };
  });
  if (resolvedLabor !== labor || resolvedFixHome !== fixHomeParts || resolvedOtherParts !== technicianParts) {
    throw new ConflictException('Tổng dòng hóa đơn không khớp bản gốc.');
  }
  const platformDue = financial.platformDue;
  const entitlement = financial.technicianPayout;
  return {
    invoiceId: invoice.id,
    successful: true,
    originalGrossVnd: gross,
    laborTotalVnd: labor,
    fixHomePartsTotalVnd: fixHomeParts,
    commissionRateSnapshot: rate,
    commissionAmountVnd: commission,
    originalPlatformDueVnd: platformDue,
    technicianEntitlementVnd: entitlement,
    items: resolvedItems,
  };
}
