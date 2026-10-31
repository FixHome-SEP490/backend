import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from './finance.service';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { VoucherReservation } from '../vouchers/entities/voucher.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { ONSITE_STOP_ACTION } from '../service-orders/onsite-interruption';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { loadVisitCharge } from './visit-charge';

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

  it.each(['solo wallet', 'solo vnpay', 'solo cash', 'visit wallet', 'visit vnpay', 'visit cash', 'solo pay',
    'stopped solo wallet', 'stopped solo vnpay', 'stopped solo cash', 'stopped solo pay',
    'stopped visit wallet', 'stopped visit vnpay', 'stopped visit cash'])(
    '%s cannot collect original gross while voucher capacity is held', async rail => {
      const stopped = rail.startsWith('stopped ');
      rail = rail.replace('stopped ', '');
      const save = vi.fn(async (value: unknown) => value);
      const customer = { id: 'customer-1', role: 'customer' };
      const technician = { id: 'technician-1', role: 'technician' };
      const invoice = { id: 'invoice-1', serviceOrderId: 'order-1', grandTotal: 100000, paymentStatus: 'unpaid' };
      const one = async (entity: unknown) => entity === AuditLog ? (stopped ? { action: ONSITE_STOP_ACTION } : null)
        : entity === VoucherReservation ? (stopped ? null : { id: 'reservation-1', state: 'RESERVED' })
        : entity === Invoice ? invoice : entity === ServiceOrder
          ? { id: 'order-1', bookingId: 'booking-1', status: 'under_repair' }
          : entity === Booking ? { id: 'booking-1', customerId: customer.id }
            : entity === TechnicianAssignment ? { technicianId: technician.id } : null;
      const manager = { findOne: one, save, update: vi.fn(), insert: vi.fn(), create: (_entity: unknown, value: unknown) => value,
        find: async (entity: unknown) => entity === VisitGroupItem && stopped ? [{ groupId: 'group-1', bookingId: 'booking-1', outcome: 'interrupted' }]
          : entity === Invoice && stopped ? [invoice] : [],
        findBy: async (entity: unknown) => entity === Booking ? [{ id: 'booking-1', status: 'matched' }]
          : entity === ServiceOrder ? [{ id: 'order-1', bookingId: 'booking-1', status: 'under_repair', completionRequestedAt: new Date() }] : [],
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

  it.each(['unpaid', 'paid', 'absent'])('group STOP %s invoice preserves the T8 sibling collection rule', async status => {
    const rows: Record<string, any[]> = {
      VisitGroupItem: [{ bookingId: 'b1', outcome: null }, { bookingId: 'b2', outcome: 'interrupted' }],
      Booking: [{ id: 'b1', status: 'matched' }, { id: 'b2', status: 'matched' }],
      ServiceOrder: [{ id: 'o1', bookingId: 'b1', completionRequestedAt: new Date() }, { id: 'o2', bookingId: 'b2' }],
      Invoice: [{ id: 'i1', serviceOrderId: 'o1', grandTotal: 100000, paymentStatus: 'unpaid' },
        ...(status === 'absent' ? [] : [{ id: 'i2', serviceOrderId: 'o2', grandTotal: 700000, paymentStatus: status }])],
    };
    const manager: any = { find: async (entity: any) => rows[entity.name] ?? [], findBy: async (entity: any) => rows[entity.name] ?? [] };
    const service = Object.create(FinanceService.prototype);
    const before = structuredClone(rows);
    const action = service.assertNoStoppedCollection(manager, 'group-1', 'VISIT_GROUP');
    if (status === 'absent') {
      await expect(action).resolves.toBeUndefined();
      expect(await loadVisitCharge(manager, 'group-1', true)).toMatchObject({ ready: true, total: 100000,
        allocations: [{ invoiceId: 'i1', serviceOrderId: 'o1', amount: 100000 }] });
    } else await expect(action).rejects.toMatchObject({ response: { code: 'CONFLICT' } });
    expect(rows).toEqual(before);
  });

  it.each(['SOLO', 'VISIT_GROUP'] as const)('Cash First %s refuses a STOP before saving an intent', async scopeKind => {
    const invoice = { id: 'i1', serviceOrderId: 'o1', grandTotal: 100000, paymentStatus: 'unpaid' };
    const one = async (entity: any) => entity === Invoice ? invoice : entity === VisitGroup ? { id: 'g1', customerId: 'c1' }
      : entity === ServiceOrder ? { id: 'o1', bookingId: 'b1' } : entity === Booking ? { id: 'b1', customerId: 'c1' }
        : entity === AuditLog ? { action: ONSITE_STOP_ACTION } : null;
    const manager: any = { findOne: one, findOneBy: one, save: vi.fn(),
      find: async (entity: any) => entity === VisitGroupItem ? [{ bookingId: 'b1', outcome: 'interrupted' }] : entity === Invoice ? [invoice] : [],
      findBy: async (entity: any) => entity === Booking ? [{ id: 'b1', status: 'matched' }]
        : entity === ServiceOrder ? [{ id: 'o1', bookingId: 'b1', status: 'under_repair' }] : [],
    };
    const service = Object.assign(Object.create(FinanceService.prototype), {
      config: { get: () => 'true' }, visitAccess: async () => ({ customerId: 'c1' }),
      dataSource: { getRepository: () => ({ findOne: async () => null }), transaction: async (fn: any) => fn(manager) },
    }) as FinanceService;
    await expect(service.createCashIntent(scopeKind, scopeKind === 'SOLO' ? 'o1' : 'g1',
      { commandId: 'command-1' }, { id: 'c1', role: 'customer' })).rejects.toMatchObject({ response: { code: 'CONFLICT' } });
    expect(manager.save).not.toHaveBeenCalled();
  });
});
