import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from './finance.service';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { VoucherReservation } from '../vouchers/entities/voucher.entity';

vi.mock('../part-requests/part-custody.policy', async importOriginal => ({
  ...(await importOriginal<typeof import('../part-requests/part-custody.policy')>()),
  lockCustodyTechnician: vi.fn(),
}));

describe('legacy collection versus a reserved voucher', () => {
  it.each(['SOLO', 'VISIT_GROUP'])('%s rechecks reservation after a concurrent funded cash declaration', async scope => {
    const save = vi.fn(async (value: unknown) => value);
    const customer = { id: 'customer-1', role: 'customer' };
    const cash = { id: 'cash-1', serviceOrderId: 'order-1', status: 'pending_confirmation',
      declaredAmount: 50000, amount: 50000,
      allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1', amount: 50000 }] };
    const manager = { findOne: async (entity: unknown) => entity === VoucherReservation ? { state: 'RESERVED' }
      : entity === ServiceOrder ? { id: 'order-1', bookingId: 'booking-1' }
        : entity === Booking ? { customerId: customer.id } : cash,
      getRepository: (entity: unknown) => ({ findOne: async () => entity === Invoice
        ? { id: 'invoice-1', grandTotal: 100000, paymentStatus: 'unpaid' }
        : entity === ServiceOrder ? { id: 'order-1', bookingId: 'booking-1' } : cash, save }),
      save, findOneBy: async () => ({ id: 'order-1', bookingId: 'booking-1' }),
      find: async () => [], findBy: async () => [],
    };
    const service = Object.assign(Object.create(FinanceService.prototype), {
      dataSource: { getRepository: () => ({ findOne: async () => null, findOneBy: async () => null }),
        transaction: async (work: (manager: unknown) => unknown) => work(manager) },
      visitAccess: async () => ({}), auditLogService: { logWithManager: vi.fn() },
      supportCasesService: { openCase: vi.fn() },
    }) as FinanceService;
    const action = scope === 'SOLO'
      ? service.confirmCashSettlement('order-1', { agreed: true }, customer)
      : service.confirmVisitCash('group-1', { agreed: true }, customer);
    await expect(action).rejects.toMatchObject({ response: { code: 'CONFLICT' } });
    expect(cash.status).toBe('pending_confirmation');
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['solo wallet', 'solo vnpay', 'solo cash', 'visit wallet', 'visit vnpay', 'visit cash', 'solo pay'])(
    '%s cannot collect original gross while voucher capacity is held', async rail => {
      const save = vi.fn(async (value: unknown) => value);
      const customer = { id: 'customer-1', role: 'customer' };
      const technician = { id: 'technician-1', role: 'technician' };
      const invoice = { id: 'invoice-1', serviceOrderId: 'order-1', grandTotal: 100000, paymentStatus: 'unpaid' };
      const one = async (entity: unknown) => entity === VoucherReservation ? { id: 'reservation-1', state: 'RESERVED' }
        : entity === Invoice ? invoice : entity === ServiceOrder
          ? { id: 'order-1', bookingId: 'booking-1', status: 'under_repair' }
          : entity === Booking ? { id: 'booking-1', customerId: customer.id }
            : entity === TechnicianAssignment ? { technicianId: technician.id } : null;
      const manager = { findOne: one, save, update: vi.fn(), insert: vi.fn(), create: (_entity: unknown, value: unknown) => value,
        getRepository: (entity: unknown) => ({ findOne: () => one(entity),
          create: (value: unknown) => value, save }) };
      const wallet = { apply: vi.fn(async () => ({ id: 'wallet-tx-1', balanceAfter: 0 })) };
      const service = Object.assign(Object.create(FinanceService.prototype), {
        dataSource: { transaction: async (work: (manager: unknown) => unknown) => work(manager) },
        getPaymentMode: async () => 'LIVE', customerWalletService: wallet,
        config: { get: () => 'configured' },
        auditLogService: { logWithManager: vi.fn() },
        markInvoicePaidOnline: vi.fn(),
        visitAccess: async () => ({ customerId: customer.id }),
        readyVisitCharge: async () => ({ total: 100000, allocations: [
          { invoiceId: invoice.id, serviceOrderId: invoice.serviceOrderId, amount: 100000 },
        ] }), cancelOpenVisitPayments: vi.fn(),
      }) as FinanceService;
      const action = () => rail === 'solo wallet' ? service.payInvoiceWithWallet(invoice.id, customer)
        : rail === 'solo vnpay' ? service.createVnpayPaymentUrl(invoice.id, customer, '127.0.0.1')
          : rail === 'solo cash' ? service.declareCashSettlement('order-1', { declaredAmount: 100000 }, technician)
            : rail === 'visit wallet' ? service.payVisitWithWallet('group-1', customer)
              : rail === 'visit vnpay' ? service.createVisitVnpayUrl('group-1', customer, '127.0.0.1')
                : rail === 'visit cash' ? service.declareVisitCash('group-1', { declaredAmount: 100000 }, technician)
                  : service.initiateInvoicePayment(invoice.id, customer, { idempotencyKey: 'attempt-1' });
      await expect(action()).rejects.toMatchObject({ response: { code: 'CONFLICT' } });
      expect(save).not.toHaveBeenCalled();
      expect(wallet.apply).not.toHaveBeenCalled();
    });
});
