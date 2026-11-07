import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from './finance.service';
import { SettlementService } from '../wallet/settlement.service';
import { settleCustodyOnline } from '../wallet/custody-settlement';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { loadVisitCharge } from './visit-charge';
import { frozenVoucherInvoiceFacts } from '../vouchers/voucher-frozen-invoice';
import { commitVerifiedVoucherSupportRefund } from '../vouchers/voucher-refund-commit';
import { SupportCase } from '../support-cases/entities/support-case.entity';

const invoice = () => ({
  id: 'invoice',
  serviceOrderId: 'order',
  shippingPolicyVersion: 'W3_70_30_V1',
  shippingFee: 20_000,
  customerShippingShare: 14_000,
  technicianShippingShare: 6_000,
  laborTotal: 100_000,
  commissionAmount: 10_000,
  commissionRateSnapshot: 0.1,
  partsTotal: 0,
  fixHomePartsTotal: 0,
  technicianPartsTotal: 0,
  technicianPartWarrantyFeeTotal: 0,
  grandTotal: 114_000,
  paymentStatus: 'unpaid',
});
const closed = 'Chính sách giao linh kiện chưa được mở thanh toán.';

describe('W3 financial cutover remains closed in real consumer entrypoints', () => {
  it.each([
    'markInvoicePaidOnline',
    'ensureFinancialDues',
    'applyConfirmedCash',
  ])('%s rejects W3 before any mutation', async (method) => {
    const service = Object.create(FinanceService.prototype);
    const row = invoice();
    const snapshot = structuredClone(row);
    const order = { id: 'order', status: 'completed' };
    const manager = { getRepository: vi.fn(), save: vi.fn(), update: vi.fn() };
    const args =
      method === 'markInvoicePaidOnline'
        ? [manager, row, 'customer', new Date()]
        : method === 'ensureFinancialDues'
          ? [manager, row, order, null, new Date()]
          : [
              manager,
              {
                invoice: row,
                order,
                settlement: {},
                actor: { id: 'customer' },
                now: new Date(),
              },
            ];
    await expect(service[method](...args)).rejects.toThrow(closed);
    expect(row).toEqual(snapshot);
    expect(manager.getRepository).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('wallet settlement rejects W3 before wallet creation/debit/credit, even if marked paid', async () => {
    const row = { ...invoice(), paymentStatus: 'paid' };
    const manager = {
      findOne: vi.fn(async (entity) =>
        entity === Invoice
          ? row
          : entity === ServiceOrder
            ? { id: 'order', status: 'completed' }
            : null,
      ),
      find: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    };
    const wallet = { getOrCreateWallet: vi.fn(), mutateBalance: vi.fn() };
    const service = new SettlementService(
      wallet as any,
      { transaction: async (fn) => fn(manager) } as any,
    );
    await expect(service.trySettleOrder('order')).rejects.toThrow(closed);
    expect(wallet.getOrCreateWallet).not.toHaveBeenCalled();
    expect(wallet.mutateBalance).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('group checkout rejects a W3 child instead of mixing unapproved money into allocations', async () => {
    const manager = {
      find: vi.fn(async (entity) =>
        entity === Invoice
          ? [invoice()]
          : entity === VisitGroupItem
            ? [{ bookingId: 'booking', sequence: 1 }]
            : [],
      ),
      findBy: vi.fn(async (entity) =>
        entity === Booking
          ? [{ id: 'booking', status: 'matched' }]
          : entity === ServiceOrder
            ? [
                {
                  id: 'order',
                  bookingId: 'booking',
                  completionRequestedAt: new Date(),
                },
              ]
            : [],
      ),
    };
    await expect(loadVisitCharge(manager as any, 'group')).rejects.toThrow(
      closed,
    );
  });

  it('custody rejects W3 before any wallet or payout ledger access', async () => {
    const manager = { find: vi.fn(), findOne: vi.fn(), insert: vi.fn() };
    const wallet = { getOrCreateWallet: vi.fn(), mutateBalance: vi.fn() };
    await expect(settleCustodyOnline(manager as any, { id: 'order' } as any,
      invoice() as any, wallet as any)).rejects.toThrow(closed);
    expect(manager.find).not.toHaveBeenCalled();
    expect(manager.findOne).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect(wallet.getOrCreateWallet).not.toHaveBeenCalled();
    expect(wallet.mutateBalance).not.toHaveBeenCalled();
  });

  it('voucher funding refuses W3 before it can infer funding entitlement', () => {
    expect(() =>
      frozenVoucherInvoiceFacts(invoice() as any, [], new Map()),
    ).toThrow(closed);
  });

  it('funded refunds refuse W3 before looking up or writing reversal ledgers', async () => {
    const manager = {
      queryRunner: { isTransactionActive: true },
      findOne: vi.fn(async (entity) =>
        entity === Invoice
          ? invoice()
          : entity === SupportCase
            ? { serviceOrderId: 'order' }
            : null,
      ),
      query: vi.fn(),
      save: vi.fn(),
    };
    await expect(
      commitVerifiedVoucherSupportRefund(manager as any, 'case'),
    ).rejects.toThrow(closed);
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });
});
