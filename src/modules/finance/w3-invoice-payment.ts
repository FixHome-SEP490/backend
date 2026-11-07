import { EntityManager } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { assertShippingFinancialCutoverAllowed } from './invoice-shipping-snapshot';
import { readInvoiceFinancialSnapshot } from './invoice-financial-snapshot';

/** SOLO existing rails only. Frozen provenance must be present in the authoritative DB row. */
export async function assertInvoiceCollectionAllowed(manager: EntityManager, invoice: Invoice): Promise<void> {
  if (invoice.shippingPolicyVersion !== 'W3_70_30_V1' || !invoice.shippingShipments?.length) {
    assertShippingFinancialCutoverAllowed(invoice);
    return;
  }
  readInvoiceFinancialSnapshot(invoice, invoice.shippingShipments);
  const facts = {
    service_order_id: invoice.serviceOrderId, shipping_policy_version: invoice.shippingPolicyVersion,
    shipping_shipments: invoice.shippingShipments,
    ...Object.fromEntries([
      ['shipping_fee', invoice.shippingFee], ['customer_shipping_share', invoice.customerShippingShare],
      ['technician_shipping_share', invoice.technicianShippingShare], ['labor_total', invoice.laborTotal],
      ['parts_total', invoice.partsTotal], ['fixhome_parts_total', invoice.fixHomePartsTotal],
      ['technician_parts_total', invoice.technicianPartsTotal],
      ['technician_part_warranty_fee_total', invoice.technicianPartWarrantyFeeTotal],
      ['commission_amount', invoice.commissionAmount], ['grand_total', invoice.grandTotal],
    ].map(([key, value]) => [key, Number(value)])),
  };
  const [row] = await manager.query(`SELECT w3_invoice_payment_verified(i.id) AS verified FROM invoices i
    WHERE i.id=$1 AND to_jsonb(i) @> $2::jsonb
      AND NOT EXISTS(SELECT 1 FROM part_custodies WHERE service_order_id=i.service_order_id)
      AND NOT EXISTS(SELECT 1 FROM bookings b JOIN service_orders o ON o.booking_id=b.id WHERE o.id=i.service_order_id AND b.visit_group_id IS NOT NULL)`, [invoice.id, JSON.stringify(facts)]);
  if (row?.verified !== true) throw new BusinessException(ErrorCodes.CONFLICT, 'Hóa đơn chưa có chứng từ giao linh kiện hợp lệ.');
}
