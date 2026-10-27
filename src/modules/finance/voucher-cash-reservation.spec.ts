import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FindOperator } from 'typeorm';
import { FinanceService } from './finance.service';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { InvoiceItem } from '../service-orders/entities/invoice-item.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Service } from '../services/entities/service.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { VoucherCampaign, VoucherClaim, VoucherReservation } from '../vouchers/entities/voucher.entity';
import { VoucherPaymentLink } from '../vouchers/entities/voucher-funding.entity';
import { Payment } from './entities/payment.entity';
import { Role, CostItemType } from '../../shared/enums';
import { VoucherDiscount } from '../vouchers/voucher.types';

// Transaction/query double: exercises real access, frozen-invoice and quote helpers.
// It does not prove PostgreSQL locks or concurrent transaction behavior.
function fixture(scopeKind: 'SOLO' | 'VISIT_GROUP' = 'SOLO') {
  const actor = { id: randomUUID(), role: Role.TECHNICIAN };
  const customerId = randomUUID();
  const groupId = randomUUID();
  const orderIds = [randomUUID(), randomUUID()];
  const bookingIds = [randomUUID(), randomUUID()];
  const invoiceIds = [randomUUID(), randomUUID()];
  const scopeId = scopeKind === 'SOLO' ? orderIds[0] : groupId;
  const now = new Date('2026-10-27T12:00:00Z');
  const policy = { discount: VoucherDiscount.PERCENT, value: 50, capVnd: null,
    minimumVnd: 0, categoryIds: [], serviceIds: [], components: ['LABOR', 'PARTS'] };
  const reservation = { id: randomUUID(), campaignId: randomUUID(), claimId: randomUUID(),
    customerId, scopeId, state: 'RESERVED', reservedAt: new Date(+now - 60000),
    expiresAt: new Date(+now + 840000), policySnapshot: policy,
    checkoutSnapshot: { eligibleSubtotalVnd: scopeKind === 'SOLO' ? 100000 : 200000 } };
  const tables = new Map<unknown, any[]>();
  const rows = (entity: unknown): any[] => {
    if (!tables.has(entity)) tables.set(entity, []);
    return tables.get(entity)!;
  };
  rows(VoucherReservation).push(reservation);
  rows(VoucherCampaign).push({ id: reservation.campaignId });
  rows(VoucherClaim).push({ id: reservation.claimId, customerId, policySnapshot: policy });
  if (scopeKind === 'VISIT_GROUP') rows(VisitGroup).push({ id: groupId, customerId });
  for (let index = 0; index < (scopeKind === 'SOLO' ? 1 : 2); index++) {
    rows(ServiceOrder).push({ id: orderIds[index], bookingId: bookingIds[index],
      completionRequestedAt: new Date(+now - 120000), status: 'under_repair' });
    rows(Booking).push({ id: bookingIds[index], customerId, serviceId: `service-${index}`,
      visitGroupId: scopeKind === 'SOLO' ? null : groupId });
    rows(Service).push({ id: `service-${index}`, categoryId: 'category-1' });
    rows(TechnicianAssignment).push({ serviceOrderId: orderIds[index], technicianId: actor.id, isActive: true });
    rows(Invoice).push({ id: invoiceIds[index], serviceOrderId: orderIds[index], paymentStatus: 'unpaid',
      laborTotal: 100000, grandTotal: 100000, partsTotal: 0, fixHomePartsTotal: 0,
      technicianPartsTotal: 0, technicianPartWarrantyFeeTotal: 0, shippingFee: 0,
      commissionRateSnapshot: 0.1, commissionAmount: 10000 });
    rows(InvoiceItem).push({ id: `item-${index}`, invoiceId: invoiceIds[index],
      sourceType: 'FIXED_PRICE', type: CostItemType.LABOR, quantity: 1, unitPrice: 100000, lineTotal: 100000 });
    if (scopeKind === 'VISIT_GROUP') rows(VisitGroupItem).push({
      groupId, bookingId: bookingIds[index], sequence: index + 1, outcome: 'succeeded',
    });
  }
  const matches = (row: any, where: any): boolean => Array.isArray(where)
    ? where.some(item => matches(row, item)) : Object.entries(where).every(([key, value]) =>
      value instanceof FindOperator && value.type === 'in'
        ? value.value.includes(row[key]) : row[key] === value);
  const find = async (entity: unknown, options: any = {}) => rows(entity)
    .filter(row => !options.where || matches(row, options.where)).slice(0, options.take ?? Infinity);
  let queryAccess: any;
  const builder: any = { innerJoin: () => builder,
    where: (_sql: string, params: any) => { queryAccess = params; return builder; },
    getCount: async () => rows(TechnicianAssignment).filter(assignment => assignment.isActive &&
      assignment.technicianId === queryAccess.technicianId && rows(ServiceOrder).some(order =>
        order.id === assignment.serviceOrderId && rows(Booking).some(booking =>
          booking.id === order.bookingId && booking.visitGroupId === queryAccess.groupId))).length };
  const manager = { queryRunner: { isTransactionActive: true },
    find: vi.fn(find), findBy: async (entity: unknown, where: any) => find(entity, { where }),
    findOne: vi.fn(async (entity: unknown, options: any) => (await find(entity, options))[0] ?? null),
    findOneBy: async (entity: unknown, where: any) => (await find(entity, { where }))[0] ?? null,
    exists: async (entity: unknown, options: any) => (await find(entity, options)).length > 0,
    query: vi.fn(async () => [{ now }]), createQueryBuilder: () => builder,
    save: vi.fn(), update: vi.fn(), insert: vi.fn(),
  };
  const service = Object.assign(Object.create(FinanceService.prototype), {
    dataSource: { query: vi.fn(async () => [{ ready: true }]), transaction: async (work: any) => work(manager) },
    vouchersService: {}, walletService: {}, customerWalletService: {}, settlementService: {},
  }) as FinanceService;
  const lookup = (who = actor) => service.getVoucherCashReservation(scopeKind, scopeId, who);
  return { service, manager, rows, actor, scopeId, reservation, lookup };
}

describe.each(['SOLO', 'VISIT_GROUP'] as const)('%s technician funded cash reservation lookup', scopeKind => {
  it('returns only the assigned technician opaque reservation and server due, without writes', async () => {
    const s = fixture(scopeKind);
    expect(await s.lookup()).toEqual({ voucherReservationId: s.reservation.id,
      customerDueVnd: scopeKind === 'SOLO' ? 50000 : 100000 });
    expect(s.manager.save).not.toHaveBeenCalled();
    expect(s.manager.update).not.toHaveBeenCalled();
    expect(s.manager.insert).not.toHaveBeenCalled();
  });

  it('returns an explicit nonfunded sentinel when no live reservation exists', async () => {
    const s = fixture(scopeKind);
    s.rows(VoucherReservation).length = 0;
    expect(await s.lookup()).toEqual({ voucherReservationId: null, customerDueVnd: null });
  });

  it('does not use the nonfunded fallback when an old payment still needs reconciliation', async () => {
    const s = fixture(scopeKind);
    s.rows(VoucherReservation).length = 0;
    s.rows(Payment).push({ invoiceId: s.rows(Invoice)[0].id, status: 'failed', failureCode: 'ALLOCATION_CHANGED' });
    await expect(s.lookup()).rejects.toMatchObject({ status: 409 });
  });

  it('does not return NONE if customer Apply commits while the lookup waits for invoice locks', async () => {
    const s = fixture(scopeKind);
    s.rows(VoucherReservation).length = 0;
    const originalFind = s.manager.find.getMockImplementation()!;
    const originalOne = s.manager.findOne.getMockImplementation()!;
    const commitApply = (entity: unknown, options: any) => {
      if (entity === Invoice && options.lock?.mode === 'pessimistic_write') {
        s.rows(VoucherReservation).push(s.reservation);
      }
    };
    s.manager.find.mockImplementation(async (entity, options) => {
      commitApply(entity, options);
      return originalFind(entity, options);
    });
    s.manager.findOne.mockImplementation(async (entity, options) => {
      commitApply(entity, options);
      return originalOne(entity, options);
    });
    await expect(s.lookup()).rejects.toMatchObject({ status: 409 });
  });

  it('does not reveal voucher data to another technician, even with no voucher', async () => {
    const s = fixture(scopeKind);
    for (const empty of [false, true]) {
      if (empty) s.rows(VoucherReservation).length = 0;
      await expect(s.lookup({ ...s.actor, id: randomUUID() })).rejects.toMatchObject({
        response: { code: 'OWNERSHIP_DENIED' }, status: 404,
      });
    }
    expect(s.manager.find.mock.calls.some(([entity]) => entity === VoucherReservation)).toBe(false);
  });

  it.each([Role.CUSTOMER, Role.ADMIN, Role.SERVICE_MANAGER])('denies role %s in the service', async role => {
    const s = fixture(scopeKind);
    await expect(s.lookup({ ...s.actor, role })).rejects.toMatchObject({ status: 403 });
  });

  it('rejects ambiguous reservations rather than picking one', async () => {
    const s = fixture(scopeKind);
    s.rows(VoucherReservation).push({ ...s.reservation, id: randomUUID() });
    await expect(s.lookup()).rejects.toMatchObject({ status: 409 });
  });

  it.each(['expired', 'wrong owner', 'stale invoice', 'redeemed', 'zero due'])('fails closed for %s', async failure => {
    const s = fixture(scopeKind);
    if (failure === 'expired') s.reservation.expiresAt = new Date('2026-10-27T12:00:00Z');
    if (failure === 'wrong owner') s.reservation.customerId = randomUUID();
    if (failure === 'stale invoice') s.rows(Invoice)[0].grandTotal += 1;
    if (failure === 'redeemed') s.reservation.state = 'REDEEMED';
    if (failure === 'zero due') s.reservation.policySnapshot = { ...s.reservation.policySnapshot, value: 100 };
    await expect(s.lookup()).rejects.toMatchObject({ status: 409 });
  });

  it.each(scopeKind === 'SOLO' ? [Payment, CashSettlement, VoucherPaymentLink]
    : [Payment, CashSettlement, VisitGroupPayment, VoucherPaymentLink])('does not return a new cash amount for existing %s collection evidence', async entity => {
    const s = fixture(scopeKind);
    s.rows(entity).push({ invoiceId: s.rows(Invoice)[0].id, serviceOrderId: s.rows(Invoice)[0].serviceOrderId,
      visitGroupId: s.scopeId, scopeId: s.scopeId, reservationId: s.reservation.id,
      status: 'pending', rail: 'VNPAY' });
    await expect(s.lookup()).rejects.toMatchObject({ status: 409 });
  });
});

it('requires the same assigned technician for every billable invoice in a visit', async () => {
  const s = fixture('VISIT_GROUP');
  s.rows(TechnicianAssignment)[1].technicianId = randomUUID();
  await expect(s.lookup()).rejects.toMatchObject({ status: 404, response: { code: 'OWNERSHIP_DENIED' } });
});

it('does not allow a grouped order to be looked up through the solo route', async () => {
  const s = fixture('SOLO');
  s.rows(Booking)[0].visitGroupId = randomUUID();
  await expect(s.lookup()).rejects.toMatchObject({ status: 404 });
});

it('excludes a failed device from visit due and billable technician assignment proof', async () => {
  const s = fixture('VISIT_GROUP');
  s.rows(VisitGroupItem)[1].outcome = 'failed';
  s.rows(ServiceOrder)[1].status = 'cancelled';
  s.rows(TechnicianAssignment)[1].isActive = false;
  s.reservation.checkoutSnapshot.eligibleSubtotalVnd = 100000;
  expect(await s.lookup()).toEqual({ voucherReservationId: s.reservation.id, customerDueVnd: 50000 });
});
