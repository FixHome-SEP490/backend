import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from './finance.service';
import { Payment } from './entities/payment.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { Role } from '../../shared/enums';

const customer = { id: 'customer', role: Role.CUSTOMER };
function setup(failedThird = false) {
  const rows = new Map<any, any[]>([
    [VisitGroup, [{ id: 'visit', customerId: customer.id }]],
    [VisitGroupItem, [1, 2, 3].map(n => ({ groupId: 'visit', sequence: n, bookingId: `b${n}`, outcome: n === 3 && failedThird ? 'failed' : 'succeeded' }))],
    [Booking, [1, 2, 3].map(n => ({ id: `b${n}`, visitGroupId: 'visit', customerId: customer.id, status: 'matched' }))],
    [ServiceOrder, [1, 2, 3].map(n => ({ id: `o${n}`, bookingId: `b${n}`, status: n === 3 && failedThird ? 'cancelled' : 'under_repair', completionRequestedAt: new Date(), paymentStatus: 'unpaid' }))],
    // Even a stale failed-device invoice must never be charged.
    [Invoice, [1, 2, 3].map(n => ({ id: `i${n}`, serviceOrderId: `o${n}`, laborTotal: n * 100000, partsTotal: 5000,
      fixHomePartsTotal: 5000, technicianPartsTotal: 0, technicianPartWarrantyFeeTotal: 0, shippingFee: 0,
      grandTotal: n * 100000 + 5000, commissionRateSnapshot: 0.1, commissionAmount: n * 10000, paymentStatus: 'unpaid' }))],
    [TechnicianAssignment, [1, 2, 3].map(n => ({ serviceOrderId: `o${n}`, technicianId: 'tech', isActive: true }))],
  ]);
  const list = (entity: any) => { if (!rows.has(entity)) rows.set(entity, []); return rows.get(entity)!; };
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]: [string, any]) =>
    value && typeof value === 'object' && value._type === 'in' ? value._value.includes(row[key]) : row[key] === value);
  const one = async (entity: any, { where }: any) => list(entity).find(row => matches(row, where)) ?? null;
  const save = async (entity: any, value: any) => {
    if (value === undefined) { value = entity; entity = VisitGroupPayment; }
    value.id ??= `saved-${list(entity).length}`;
    if (!list(entity).includes(value)) list(entity).push(value);
    return value;
  };
  const update = async (entity: any, where: any, changes: any) => {
    for (const row of list(entity)) if (matches(row, where)) Object.assign(row, changes);
  };
  const query: any = { update: () => query, set: () => query, where: () => query, andWhere: () => query, execute: async () => ({ affected: 0 }) };
  const manager: any = {
    find: vi.fn(async (entity, options) => list(entity).filter(row => !options?.where || matches(row, options.where))),
    findBy: async (entity, where) => list(entity).filter(row => matches(row, where)),
    findOne: vi.fn(one), findOneOrFail: one, findOneBy: (entity, where) => one(entity, { where }),
    create: (_entity, value) => ({ ...value }), save, update, insert: vi.fn(), count: async () => 0,
    createQueryBuilder: () => query,
    getRepository: entity => ({ findOne: options => one(entity, options), create: value => ({ ...value }),
      save: value => save(entity, value), update: (where, changes) => update(entity, where, changes) }),
  };
  const wallet = { apply: vi.fn(async () => ({ id: 'wallet-tx', balanceAfter: 1000000 })) };
  const service: FinanceService = Object.assign(Object.create(FinanceService.prototype), {
    dataSource: { transaction: work => work(manager) }, customerWalletService: wallet,
    auditLogService: { logWithManager: vi.fn() }, logger: { warn: vi.fn() },
  });
  return { service, wallet, list, manager };
}

describe('E0 one parent payment uses child invoice snapshots', () => {
  it.each([false, true])('debits once, allocates only successful children and refuses a second debit (failed third: %s)', async failed => {
    const s = setup(failed);
    expect(await s.service.payVisitWithWallet('visit', customer)).toMatchObject({ amount: failed ? 310000 : 615000, paid: true });
    expect(s.wallet.apply).toHaveBeenCalledExactlyOnceWith(s.manager, expect.objectContaining({ amount: failed ? 310000 : 615000, idempotencyKey: 'VISIT:visit' }));
    expect(s.list(Payment).map(row => [row.invoiceId, row.amount])).toEqual(failed ? [['i1', 105000], ['i2', 205000]] : [['i1', 105000], ['i2', 205000], ['i3', 305000]]);
    expect(s.list(Invoice).map(row => row.paymentStatus)).toEqual(failed ? ['paid', 'paid', 'unpaid'] : ['paid', 'paid', 'paid']);
    expect(s.list(VisitGroupPayment)).toMatchObject([{ status: 'verified', amount: failed ? 310000 : 615000 }]);
    await expect(s.service.payVisitWithWallet('visit', customer)).rejects.toMatchObject({ status: 409 });
    expect(s.wallet.apply).toHaveBeenCalledOnce();
  });

  it('refuses checkout for another customer or while a device remains open', async () => {
    const s = setup();
    await expect(s.service.payVisitWithWallet('visit', { ...customer, id: 'stranger' })).rejects.toMatchObject({ status: 404, response: { code: 'OWNERSHIP_DENIED' } });
    s.list(ServiceOrder)[2].completionRequestedAt = null;
    await expect(s.service.payVisitWithWallet('visit', customer)).rejects.toMatchObject({ status: 409 });
    expect(s.wallet.apply).not.toHaveBeenCalled();
    expect(s.list(Payment)).toHaveLength(0);
  });

  it.each([false, true])('VNPay applies its frozen split once or holds changed allocations (changed: %s)', async changed => {
    const s = setup(true);
    const payment = { id: 'attempt', visitGroupId: 'visit', rail: 'vnpay', status: 'pending', amount: 310000,
      requestedByUserId: customer.id, idempotencyKey: 'vnpay-attempt', requestedAt: new Date(),
      allocations: [{ invoiceId: 'i1', serviceOrderId: 'o1', amount: 105000 }, { invoiceId: 'i2', serviceOrderId: 'o2', amount: 205000 }] };
    s.list(VisitGroupPayment).push(payment);
    if (changed) s.list(Invoice)[1].grandTotal = 205001;
    await (s.service as any).applyVisitVnpay('attempt', 'verified-provider-reference');
    await (s.service as any).applyVisitVnpay('attempt', 'verified-provider-reference');
    expect(payment).toMatchObject(changed ? { status: 'failed', failureCode: 'ALLOCATION_CHANGED' } : { status: 'verified' });
    expect(s.list(Payment).map(row => [row.invoiceId, row.amount])).toEqual(changed ? [] : [['i1', 105000], ['i2', 205000]]);
    expect(s.list(Invoice)[2].paymentStatus).toBe('unpaid');
  });
});
