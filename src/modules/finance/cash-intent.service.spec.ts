import { describe, expect, it, vi } from 'vitest';
import { PaymentStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Payment } from './entities/payment.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { CashPaymentIntent } from './entities/cash-payment-intent.entity';
import { FinanceService } from './finance.service';

const commandId = '7de9bf22-54ed-4a7f-af84-641706aac559';

function setup(intent?: any, invoiceOverrides: object = {}) {
  const invoice = { id: 'invoice-1', serviceOrderId: 'order-1', grandTotal: 120_000,
    paymentStatus: PaymentStatus.UNPAID, ...invoiceOverrides };
  const order = { id: 'order-1', bookingId: 'booking-1', status: ServiceOrderStatus.UNDER_REPAIR,
    completionRequestedAt: new Date() };
  const booking = { id: 'booking-1', customerId: 'customer-1', visitGroupId: null };
  const assignment = { technicianId: 'tech-1', serviceOrderId: 'order-1', isActive: true };
  const save = vi.fn(async (entity, value) => ({ id: entity === CashSettlement ? 'cash-1' : 'intent-1', ...value }));
  const manager = {
    findOne: vi.fn(async (entity: any, _options?: any) => entity === Invoice ? invoice : entity === ServiceOrder ? order :
      entity === Booking ? booking : entity === TechnicianAssignment ? assignment :
      entity === CashPaymentIntent ? intent ?? null : null),
    findOneBy: vi.fn(async (entity: any, _options?: any) => entity === Invoice ? invoice : entity === ServiceOrder ? order :
      entity === Booking ? booking : entity === CashPaymentIntent ? intent ?? null : null),
    findOneOrFail: vi.fn(async (entity) => entity === Invoice ? invoice : entity === ServiceOrder ? order : null),
    find: vi.fn(async (_entity?: any, _options?: any) => []),
    exists: vi.fn(async () => false),
    count: vi.fn(async () => 0),
    insert: vi.fn(async () => undefined),
    query: vi.fn(async () => []),
    create: vi.fn((_entity, value) => value), save,
    queryRunner: { isTransactionActive: true },
  };
  const service = Object.assign(Object.create(FinanceService.prototype), {
    dataSource: { transaction: async (callback: (value: any) => unknown) => callback(manager),
      getRepository: () => ({ findOneBy: async () => intent ?? null, findOne: async () => null }) },
    config: { get: () => 'true' },
    auditLogService: { logWithManager: vi.fn(async () => undefined) },
    assertLegacyCollectionAllowed: vi.fn(async () => undefined),
    assertFundedCollectionReady: vi.fn(async () => undefined),
    applyConfirmedCash: vi.fn(async () => undefined),
  }) as FinanceService;
  return { service, manager, save, invoice, order, booking };
}

const shippingClosed = 'Chính sách giao linh kiện chưa được mở thanh toán.';
const w3Invoice = { shippingPolicyVersion: 'W3_70_30_V1', shippingFee: 20_000,
  customerShippingShare: 14_000, technicianShippingShare: 6_000, grandTotal: 114_000 };
const legacyShipping = { shippingPolicyVersion: 'LEGACY_100_0', shippingFee: 20_000,
  customerShippingShare: 20_000, technicianShippingShare: 0 };
const cashIntent = (overrides = {}, amount = 120_000) => ({ id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1',
  customerId: 'customer-1', technicianId: 'tech-1', status: 'pending', commandId,
  grossVnd: amount, customerDueVnd: amount, voucherReservationId: null,
  allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1', originalGrossVnd: amount, customerDueVnd: amount }],
  ...overrides });
const receiptInput = { intentId: 'intent-1', commandId, receivedAmountVnd: 120_000, receiptEvidenceUrl: 'evidence-1' };
const receivedIntent = (amount = 120_000) => cashIntent({ status: 'received', receiptCommandId: commandId,
  receivedAmountVnd: amount, receiptEvidenceUrl: receiptInput.receiptEvidenceUrl }, amount);
const cashCustomer = { id: 'customer-1', role: Role.CUSTOMER };
const cashTechnician = { id: 'tech-1', role: Role.TECHNICIAN };

function groupReplaySetup(received = false, w3Child = -1) {
  const group = { id: 'group-1', customerId: cashCustomer.id };
  const items = [1, 2].map(i => ({ groupId: group.id, bookingId: `booking-${i}`, sequence: i, outcome: null as 'failed' | null }));
  const bookings = items.map(item => ({ id: item.bookingId, visitGroupId: group.id,
    customerId: group.customerId, status: 'matched' }));
  const orders = items.map((item, i) => ({ id: `order-${i + 1}`, bookingId: item.bookingId,
    status: received ? ServiceOrderStatus.COMPLETED : ServiceOrderStatus.UNDER_REPAIR, completionRequestedAt: new Date() }));
  const invoices = orders.map((order, i) => ({ id: `invoice-${i + 1}`, serviceOrderId: order.id,
    grandTotal: 120_000, ...legacyShipping, ...(i === w3Child ? w3Invoice : {}),
    paymentStatus: received ? PaymentStatus.PAID : PaymentStatus.UNPAID }));
  const allocations = invoices.map(row => ({ invoiceId: row.id, serviceOrderId: row.serviceOrderId,
    originalGrossVnd: row.grandTotal, customerDueVnd: row.grandTotal }));
  const amount = allocations.reduce((sum, a) => sum + a.originalGrossVnd, 0);
  const intent = { ...cashIntent({ scopeKind: 'VISIT_GROUP', scopeId: group.id, allocations,
    status: received ? 'received' : 'pending' }, amount),
    receiptCommandId: received ? commandId : null, receivedAmountVnd: received ? amount : null,
    receiptEvidenceUrl: received ? 'evidence-1' : null, visitGroupPaymentId: received ? 'group-payment-1' : null };
  const payment = { id: 'group-payment-1', visitGroupId: group.id, rail: 'cash', status: 'verified',
    amount, requestedByUserId: cashTechnician.id, idempotencyKey: `CASH_INTENT:${intent.id}`,
    allocations: allocations.map(a => ({ invoiceId: a.invoiceId, serviceOrderId: a.serviceOrderId, amount: a.customerDueVnd })) };
  const { service, manager, save } = setup(intent);
  const byId = (rows: any[], where: any) => rows.find(row => Object.entries(where ?? {}).every(([key, value]) => row[key] === value)) ?? null;
  manager.findOne.mockImplementation(async (entity, options) => entity === VisitGroup ? byId([group], options?.where)
    : entity === Booking ? byId(bookings, options?.where) : entity === ServiceOrder ? byId(orders, options?.where)
      : entity === Invoice ? byId(invoices, options?.where) : entity === VisitGroupPayment ? byId([payment], options?.where)
        : entity === CashPaymentIntent ? intent : null);
  const all = (entity: any) => entity === VisitGroupItem ? items : entity === Booking ? bookings
    : entity === ServiceOrder ? orders : entity === Invoice ? invoices : [];
  const matches = (row: any, where: any) => Object.entries(where ?? {}).every(([key, value]: [string, any]) =>
    value?._type === 'in' ? value._value.includes(row[key]) : row[key] === value);
  manager.find.mockImplementation(async (entity, options?: any) => all(entity).filter(row => matches(row, options?.where)) as never);
  (manager as any).findBy = vi.fn(async (entity, where) => all(entity).filter(row => matches(row, where)));
  const repository = { findOne: vi.fn(async () => intent), findOneBy: vi.fn(async () => intent) };
  (service as any).dataSource.getRepository = () => repository;
  (service as any).readyVisitCharge = vi.fn(async () => { throw new Error('Replay must not require unpaid readiness'); });
  const input = { ...receiptInput, receivedAmountVnd: amount };
  return { service, manager, save, group, items, bookings, orders, invoices, intent, payment, repository, input };
}

describe('group cash replay shipping gate', () => {
  it.each([0, 1])('rejects create replay with W3 child at position %s among legacy snapshots', async index => {
    const f = groupReplaySetup(false, index);
    await expect(f.service.createCashIntent('VISIT_GROUP', f.group.id, { commandId }, cashCustomer)).rejects.toThrow(shippingClosed);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.manager.insert).not.toHaveBeenCalled();
    expect((f.service as any).auditLogService.logWithManager).not.toHaveBeenCalled();
  });

  it.each([0, 1])('rejects already-received replay with W3 child at position %s', async index => {
    const f = groupReplaySetup(true, index);
    await expect(f.service.receiveCashIntent('VISIT_GROUP', f.group.id, f.input, cashTechnician)).rejects.toThrow(shippingClosed);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.manager.insert).not.toHaveBeenCalled();
    expect((f.service as any).applyConfirmedCash).not.toHaveBeenCalled();
  });

  it.each([false, true])('validates the concurrent winner fallback (W3=%s)', async w3 => {
    const f = groupReplaySetup(true, w3 ? 1 : -1);
    f.repository.findOneBy.mockResolvedValueOnce({ ...f.intent, status: 'pending' } as never);
    (f.service as any).dataSource.transaction = vi.fn().mockRejectedValueOnce(new Error('concurrent group receipt winner'))
      .mockImplementation(async callback => callback(f.manager));
    const result = f.service.receiveCashIntent('VISIT_GROUP', f.group.id, f.input, cashTechnician);
    if (w3) await expect(result).rejects.toThrow(shippingClosed);
    else await expect(result).resolves.toBe(f.intent);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.manager.insert).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves complete LEGACY create replay, including received status=%s', async received => {
    const f = groupReplaySetup(received);
    await expect(f.service.createCashIntent('VISIT_GROUP', f.group.id, { commandId }, cashCustomer)).resolves.toBe(f.intent);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('preserves already-paid LEGACY receipt replay after assignment is no longer active', async () => {
    const f = groupReplaySetup(true);
    await expect(f.service.receiveCashIntent('VISIT_GROUP', f.group.id, f.input, cashTechnician)).resolves.toBe(f.intent);
    expect((f.service as any).readyVisitCharge).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    const calls = f.manager.findOne.mock.calls;
    expect(calls[0]).toEqual([VisitGroup, expect.objectContaining({ lock: { mode: 'pessimistic_write' } })]);
    for (const [entity, options] of calls) if (entity === Invoice) expect(options).not.toHaveProperty('lock');
    for (const [entity, options] of f.manager.find.mock.calls) if (entity === Invoice) expect(options).not.toHaveProperty('lock');
  });

  it.each(['paid', 'cancelled'] as const)('preserves a historical LEGACY create replay after the invoice becomes %s', async status => {
    const f = groupReplaySetup();
    if (status === 'paid') for (const invoice of f.invoices) invoice.paymentStatus = PaymentStatus.PAID;
    else {
      f.intent.status = 'cancelled';
      for (const order of f.orders) order.status = ServiceOrderStatus.CANCELLED;
    }
    await expect(f.service.createCashIntent('VISIT_GROUP', f.group.id, { commandId }, cashCustomer)).resolves.toBe(f.intent);
    expect(f.save).not.toHaveBeenCalled();
    expect((f.service as any).readyVisitCharge).not.toHaveBeenCalled();
  });

  it.each(['owner', 'booking_owner', 'booking_group', 'item_membership', 'forged_invoice', 'forged_order',
    'empty', 'missing', 'duplicate', 'missing_invoice', 'missing_payment', 'payment_allocation'])(
    'fails closed on group ownership/allocation inconsistency: %s', async issue => {
      const f = groupReplaySetup(true);
      if (issue === 'owner') f.group.customerId = 'other-customer';
      if (issue === 'booking_owner') f.bookings[1].customerId = 'other-customer';
      if (issue === 'booking_group') f.bookings[1].visitGroupId = 'other-group';
      if (issue === 'item_membership') f.items.pop();
      if (issue === 'forged_invoice') f.intent.allocations[1].invoiceId = 'other-invoice';
      if (issue === 'forged_order') f.intent.allocations[1].serviceOrderId = 'order-1';
      if (issue === 'empty') f.intent.allocations = [];
      if (issue === 'missing') f.intent.allocations.pop();
      if (issue === 'duplicate') f.intent.allocations[1] = { ...f.intent.allocations[0] };
      if (issue === 'missing_invoice') f.invoices.pop();
      if (issue === 'missing_payment') f.intent.visitGroupPaymentId = 'missing-payment';
      if (issue === 'payment_allocation') f.payment.allocations.pop();
      await expect(f.service.receiveCashIntent('VISIT_GROUP', f.group.id, f.input, cashTechnician)).rejects.toThrow();
      expect(f.save).not.toHaveBeenCalled();
      expect(f.manager.insert).not.toHaveBeenCalled();
    });

  it('rejects a pending create replay with a missing LEGACY allocation even if frozen totals were reduced', async () => {
    const f = groupReplaySetup();
    f.intent.allocations.pop(); f.intent.grossVnd = 120_000; f.intent.customerDueVnd = 120_000;
    await expect(f.service.createCashIntent('VISIT_GROUP', f.group.id, { commandId }, cashCustomer)).rejects.toThrow();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('does not let an intent hide a W3 child by removing its allocation and reducing every amount', async () => {
    const f = groupReplaySetup(true, 1);
    f.intent.allocations.pop(); f.payment.allocations.pop();
    f.intent.grossVnd = 120_000; f.intent.customerDueVnd = 120_000;
    f.intent.receivedAmountVnd = 120_000; f.payment.amount = 120_000;
    await expect(f.service.receiveCashIntent('VISIT_GROUP', f.group.id, { ...f.input, receivedAmountVnd: 120_000 }, cashTechnician)).rejects.toThrow(shippingClosed);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('does not require allocation for a failed unbilled group child', async () => {
    const f = groupReplaySetup(true);
    f.items.push({ groupId: f.group.id, bookingId: 'failed-booking', sequence: 3, outcome: 'failed' });
    f.bookings.push({ id: 'failed-booking', visitGroupId: f.group.id, customerId: cashCustomer.id, status: 'closed' });
    await expect(f.service.receiveCashIntent('VISIT_GROUP', f.group.id, f.input, cashTechnician)).resolves.toBe(f.intent);
  });

  it('preserves frozen LEGACY allocations when another child was already paid before this intent', async () => {
    const f = groupReplaySetup(true);
    f.intent.allocations.pop(); f.payment.allocations.pop();
    f.intent.grossVnd = 120_000; f.intent.customerDueVnd = 120_000;
    f.intent.receivedAmountVnd = 120_000; f.payment.amount = 120_000;
    await expect(f.service.receiveCashIntent('VISIT_GROUP', f.group.id, { ...f.input, receivedAmountVnd: 120_000 }, cashTechnician)).resolves.toBe(f.intent);
  });

  it('preserves funded LEGACY receipt allocations including a zero-net child without repricing vouchers', async () => {
    const f = groupReplaySetup(true);
    f.intent.voucherReservationId = 'reservation-1';
    f.intent.allocations[0].customerDueVnd = 0;
    f.intent.allocations[1].customerDueVnd = 90_000;
    f.payment.allocations[0].amount = 0;
    f.payment.allocations[1].amount = 90_000;
    f.intent.customerDueVnd = 90_000; f.intent.receivedAmountVnd = 90_000; f.payment.amount = 90_000;
    (f.service as any).quoteVoucherRail = vi.fn();
    await expect(f.service.receiveCashIntent('VISIT_GROUP', f.group.id, { ...f.input, receivedAmountVnd: 90_000 }, cashTechnician)).resolves.toBe(f.intent);
    expect((f.service as any).quoteVoucherRail).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('verifies group ownership before revealing a mixed W3 shipping policy', async () => {
    const f = groupReplaySetup(true, 1);
    f.group.customerId = 'other-customer';
    await expect(f.service.receiveCashIntent('VISIT_GROUP', f.group.id, f.input, cashTechnician))
      .rejects.toThrow('Không tìm thấy phân bổ tiền mặt hợp lệ của lượt sửa.');
    expect(f.manager.find).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
});

describe('cash-first intent', () => {
  it('rejects W3 SOLO create before saving an intent, audit or notification', async () => {
    const { service, manager, save, invoice } = setup(undefined, w3Invoice);
    const before = structuredClone(invoice);
    await expect(service.createCashIntent('SOLO', 'order-1', { commandId }, cashCustomer)).rejects.toThrow(shippingClosed);
    expect(save).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect((service as any).auditLogService.logWithManager).not.toHaveBeenCalled();
    expect(invoice).toEqual(before);
  });

  it('rejects W3 SOLO receipt before physical cash evidence or final applyConfirmedCash', async () => {
    const pending = cashIntent({}, 114_000);
    const { service, manager, save } = setup(pending, w3Invoice);
    const before = structuredClone(pending);
    await expect(service.receiveCashIntent('SOLO', 'order-1', { ...receiptInput, receivedAmountVnd: 114_000 }, cashTechnician)).rejects.toThrow(shippingClosed);
    expect(save).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect((service as any).applyConfirmedCash).not.toHaveBeenCalled();
    expect((service as any).auditLogService.logWithManager).not.toHaveBeenCalled();
    expect(pending).toEqual(before);
  });

  it('does not leak the W3 shipping policy before SOLO ownership is verified', async () => {
    const { service, manager, save } = setup(undefined, w3Invoice);
    await expect(service.createCashIntent('SOLO', 'order-1', { commandId }, { ...cashCustomer, id: 'other-customer' }))
      .rejects.toThrow('Không tìm thấy đơn sửa chữa.');
    expect(save).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it.each([['W3_70_30_V1', w3Invoice], ['LEGACY_100_0', legacyShipping]] as const)(
    'checks SOLO create replay against its owned invoice (%s)', async (policy, shipping) => {
      const intent = cashIntent({}, policy === 'W3_70_30_V1' ? 114_000 : 120_000);
      const { service, manager, save } = setup(intent, shipping);
      (service as any).dataSource.getRepository = () => ({ findOne: async () => intent });
      const result = service.createCashIntent('SOLO', 'order-1', { commandId }, cashCustomer);
      if (policy === 'W3_70_30_V1') await expect(result).rejects.toThrow(shippingClosed);
      else await expect(result).resolves.toBe(intent);
      expect(save).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

  it('does not acknowledge a disallowed W3 same-command receipt replay', async () => {
    const received = receivedIntent(114_000);
    const { service, manager, save } = setup(received, { ...w3Invoice, paymentStatus: PaymentStatus.PAID });
    await expect(service.receiveCashIntent('SOLO', 'order-1', { ...receiptInput, receivedAmountVnd: 114_000 }, cashTechnician)).rejects.toThrow(shippingClosed);
    expect(save).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect((service as any).applyConfirmedCash).not.toHaveBeenCalled();
  });

  it.each([['W3_70_30_V1', w3Invoice], ['LEGACY_100_0', legacyShipping]] as const)(
    'checks the received-intent race fallback before returning success (%s)', async (policy, shipping) => {
      const amount = policy === 'W3_70_30_V1' ? 114_000 : 120_000;
      const received = receivedIntent(amount);
      const { service, manager, save } = setup(received, { ...shipping, paymentStatus: PaymentStatus.PAID });
      // Keep one repository instance so the initial reference is pending, then the winner is received.
      const repository = { findOneBy: vi.fn().mockResolvedValueOnce(cashIntent({}, amount)).mockResolvedValue(received) };
      (service as any).dataSource.getRepository = () => repository;
      (service as any).dataSource.transaction = vi.fn().mockRejectedValueOnce(new Error('concurrent receipt winner'))
        .mockImplementation(async callback => callback(manager));
      const result = service.receiveCashIntent('SOLO', 'order-1', { ...receiptInput, receivedAmountVnd: amount }, cashTechnician);
      if (policy === 'W3_70_30_V1') await expect(result).rejects.toThrow(shippingClosed);
      else await expect(result).resolves.toBe(received);
      expect(save).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
      expect((service as any).applyConfirmedCash).not.toHaveBeenCalled();
    });

  it('keeps replay fail-closed on mismatched invoice ownership without revealing W3 policy', async () => {
    const received = receivedIntent();
    const { service, manager, booking } = setup(received, w3Invoice);
    booking.customerId = 'different-customer';
    await expect(service.receiveCashIntent('SOLO', 'order-1', receiptInput, cashTechnician))
      .rejects.toThrow('Không tìm thấy đơn sửa chữa.');
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('checks legacy receipt replay with Order lock before the immutable invoice read, without reacquiring an invoice write lock', async () => {
    const received = receivedIntent();
    const { service, manager } = setup(received, { ...legacyShipping, paymentStatus: PaymentStatus.PAID });
    await expect(service.receiveCashIntent('SOLO', 'order-1', receiptInput, cashTechnician)).resolves.toBe(received);
    const calls = manager.findOne.mock.calls;
    const orderIndex = calls.findIndex(([entity]) => entity === ServiceOrder);
    const invoiceIndex = calls.findIndex(([entity]) => entity === Invoice);
    expect(orderIndex).toBeGreaterThanOrEqual(0);
    expect(invoiceIndex).toBeGreaterThan(orderIndex);
    expect(calls[orderIndex][1]).toMatchObject({ lock: { mode: 'pessimistic_write' } });
    expect(calls[invoiceIndex][1]).not.toHaveProperty('lock');
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('records customer-owned intent without paying or creating any collection', async () => {
    const { service, manager, save, invoice, order } = setup();
    const result = await (service as any).createCashIntent('SOLO', order.id, { commandId },
      { id: 'customer-1', role: Role.CUSTOMER });
    expect(result).toMatchObject({ status: 'pending', customerDueVnd: 120_000, technicianId: 'tech-1' });
    expect(invoice.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(order.status).toBe(ServiceOrderStatus.UNDER_REPAIR);
    expect(save).toHaveBeenCalledOnce();
    expect(manager.findOne).toHaveBeenCalledWith(CashSettlement, expect.anything());
    expect(manager.find).toHaveBeenCalledWith(Payment, expect.anything());
  });

  it('rejects a different customer before writing intent', async () => {
    const { service, save } = setup();
    await expect((service as any).createCashIntent('SOLO', 'order-1', { commandId },
      { id: 'another-customer', role: Role.CUSTOMER })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps new customer-intent mutations closed before client cutover', async () => {
    const { service, save } = setup();
    (service as any).config = { get: () => 'false' };
    await expect((service as any).createCashIntent('SOLO', 'order-1', { commandId },
      { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps legacy Mobile cash declaration and historical confirmation reachable while flag is off', async () => {
    const { service } = setup();
    (service as any).config = { get: () => 'false' };
    const reached = new Error('legacy transaction reached');
    const transaction = vi.fn(async () => { throw reached; });
    (service as any).dataSource.transaction = transaction;
    (service as any).dataSource.getRepository = () => ({ findOneBy: async () => null });
    await expect(service.declareCashSettlement('order-1', { declaredAmount: 120_000 } as any,
      { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toBe(reached);
    await expect(service.declareVisitCash('group-1', { declaredAmount: 120_000 } as any,
      { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toBe(reached);
    await expect(service.confirmCashSettlement('order-1', { agreed: true } as any,
      { id: 'customer-1', role: Role.CUSTOMER })).rejects.toBe(reached);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('closes technician-first legacy declarations after activation for every client', async () => {
    const { service } = setup();
    (service as any).config = { get: (key: string) => key === 'CASH_FIRST_ENABLED' ? 'true' : undefined };
    const transaction = vi.fn();
    (service as any).dataSource.transaction = transaction;
    await expect(service.declareCashSettlement('order-1', { declaredAmount: 120_000 } as any,
      { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow();
    await expect(service.declareVisitCash('group-1', { declaredAmount: 120_000 } as any,
      { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('permits a temporary legacy declaration with compatibility enabled but refuses a pending new intent', async () => {
    const pending = { id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', status: 'pending' };
    const { service, manager } = setup(pending);
    (service as any).config = { get: (key: string) => key === 'CASH_FIRST_ENABLED' ||
      key === 'CASH_LEGACY_COMPAT_ENABLED' ? 'true' : undefined };
    const transaction = vi.fn(async () => { throw new Error('legacy route entered'); });
    (service as any).dataSource.transaction = transaction;
    await expect(service.declareCashSettlement('order-1', { declaredAmount: 120_000 } as any,
      { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow('legacy route entered');
    await expect((service as any).assertLegacyCashCompatibility(manager, 'SOLO', 'order-1')).rejects.toThrow();
    expect(transaction).toHaveBeenCalledOnce();
    expect(manager.findOne).toHaveBeenCalledWith(CashPaymentIntent, expect.objectContaining({
      where: { scopeKind: 'SOLO', scopeId: 'order-1', status: 'pending' },
    }));
  });

  it('allows compatibility check for a separate scope with no pending intent', async () => {
    const { service, manager } = setup();
    (service as any).config = { get: (key: string) => key === 'CASH_FIRST_ENABLED' ||
      key === 'CASH_LEGACY_COMPAT_ENABLED' ? 'true' : undefined };
    await expect((service as any).assertLegacyCashCompatibility(manager, 'VISIT_GROUP', 'group-2'))
      .resolves.toBeUndefined();
  });

  it('allows legacy confirmation after a cancelled intent but still checks pending or received intent', async () => {
    const { service } = setup();
    const reached = new Error('legacy confirmation reached');
    const exists = vi.fn(async (_options?: any) => false);
    (service as any).dataSource.getRepository = () => ({ exists, findOneBy: async () => null });
    (service as any).dataSource.transaction = async () => { throw reached; };
    await expect(service.confirmCashSettlement('order-1', { agreed: true } as any,
      { id: 'customer-1', role: Role.CUSTOMER })).rejects.toBe(reached);
    const query = exists.mock.calls[0]?.[0] as any;
    expect(query.where).toMatchObject({ scopeKind: 'SOLO', scopeId: 'order-1' });
    expect(query.where.status.value).toEqual(['pending', 'received']);
  });

  it('refuses technician receipt without a matching customer intent', async () => {
    const { service, save } = setup();
    await expect((service as any).receiveCashIntent('SOLO', 'order-1', {
      intentId: 'missing', commandId, receivedAmountVnd: 120_000,
    }, { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('calls the existing cash finalization exactly once after a matching technician receipt', async () => {
    const pending = { id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', customerId: 'customer-1',
      technicianId: 'tech-1', status: 'pending', grossVnd: 120_000, customerDueVnd: 120_000,
      voucherReservationId: null, allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1',
        originalGrossVnd: 120_000, customerDueVnd: 120_000 }] };
    const { service, manager } = setup(pending);
    const result = await (service as any).receiveCashIntent('SOLO', 'order-1', {
      intentId: 'intent-1', commandId, receivedAmountVnd: 120_000,
    }, { id: 'tech-1', role: Role.TECHNICIAN });
    expect(result.status).toBe('received');
    expect((service as any).applyConfirmedCash).toHaveBeenCalledOnce();
    expect(manager.save).toHaveBeenCalledWith(CashSettlement, expect.objectContaining({
      status: 'confirmed', declaredAmount: 120_000, confirmedByCustomerId: 'customer-1',
    }));
  });

  it('lets the owner cancel an unreceived intent without a financial mutation', async () => {
    const pending = { id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', customerId: 'customer-1',
      technicianId: 'tech-1', status: 'pending', cancelCommandId: null };
    const { service, manager } = setup(pending);
    const result = await (service as any).cancelCashIntent('SOLO', 'order-1',
      { intentId: 'intent-1', commandId }, { id: 'customer-1', role: Role.CUSTOMER });
    expect(result.status).toBe('cancelled');
    expect(manager.save).toHaveBeenCalledWith(CashPaymentIntent, expect.objectContaining({ status: 'cancelled' }));
    expect((service as any).applyConfirmedCash).not.toHaveBeenCalled();
  });

  it('blocks another payment rail while a cash intent is active', async () => {
    const pending = { id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', status: 'pending' };
    const { service, manager } = setup(pending);
    await expect((service as any).assertNoActiveCashIntent(manager, 'SOLO', 'order-1')).rejects.toThrow();
  });

  it('freezes funded cash at customer NET while preserving invoice gross', async () => {
    const { service, invoice, order, save } = setup();
    (service as any).quoteVoucherRail = vi.fn(async () => ({ total: {
      originalGrossVnd: 120_000, customerDueVnd: 90_000,
    } }));
    const intent = await (service as any).createCashIntent('SOLO', order.id,
      { commandId, voucherReservationId: 'reservation-1' }, { id: 'customer-1', role: Role.CUSTOMER });
    expect(intent).toMatchObject({ grossVnd: 120_000, customerDueVnd: 90_000,
      allocations: [{ originalGrossVnd: 120_000, customerDueVnd: 90_000 }] });
    expect(invoice.grandTotal).toBe(120_000);
    expect(save).toHaveBeenCalledOnce();
  });

  it('refuses cash intent while an invoice provider attempt is unresolved', async () => {
    const { service, manager, save } = setup();
    manager.find.mockResolvedValue([{ status: 'pending' }] as never);
    await expect((service as any).createCashIntent('SOLO', 'order-1', { commandId },
      { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a new SOLO intent while any historical cash settlement exists', async () => {
    const { service, manager, save } = setup();
    const original = manager.findOne.getMockImplementation()!;
    manager.findOne.mockImplementation(async (entity, options) => entity === CashSettlement
      ? { id: 'legacy-cash', status: 'pending_confirmation' } as never
      : original(entity, options));
    await expect((service as any).createCashIntent('SOLO', 'order-1', { commandId },
      { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a new VISIT_GROUP intent while a legacy group cash payment exists', async () => {
    const { service, manager, save } = setup();
    (service as any).visitAccess = vi.fn(async () => ({ id: 'group-1', customerId: 'customer-1' }));
    (service as any).readyVisitCharge = vi.fn(async () => ({ total: 120_000,
      allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1', amount: 120_000 }] }));
    const originalFindOneBy = manager.findOneBy.getMockImplementation()!;
    manager.findOneBy.mockImplementation(async (entity, options) => entity?.name === 'VisitGroup'
      ? { id: 'group-1', customerId: 'customer-1' } as never : originalFindOneBy(entity, options));
    manager.find.mockImplementation(async entity => entity === VisitGroupPayment
      ? [{ id: 'old-group-cash', rail: 'cash', status: 'pending_confirmation' }] as never : []);
    await expect((service as any).createCashIntent('VISIT_GROUP', 'group-1', { commandId },
      { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a wrong physical amount without creating cash evidence', async () => {
    const pending = { id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', customerId: 'customer-1',
      technicianId: 'tech-1', status: 'pending', grossVnd: 120_000, customerDueVnd: 120_000,
      voucherReservationId: null, allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1',
        originalGrossVnd: 120_000, customerDueVnd: 120_000 }] };
    const { service, manager } = setup(pending);
    await expect((service as any).receiveCashIntent('SOLO', 'order-1', {
      intentId: 'intent-1', commandId, receivedAmountVnd: 119_000,
    }, { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
    expect((service as any).applyConfirmedCash).not.toHaveBeenCalled();
  });

  it('does not let funded legacy customer confirmation act as a third approval', async () => {
    const { service } = setup();
    (service as any).dataSource.getRepository = () => ({ exists: async () => true });
    (service as any).confirmVoucherCash = vi.fn();
    await expect(service.confirmVoucherCashByReservation('order-1', { agreed: true } as any,
      { id: 'customer-1', role: Role.CUSTOMER }, 'reservation-1')).rejects.toThrow();
    expect((service as any).confirmVoucherCash).not.toHaveBeenCalled();
  });

  it('returns the same receipt only for the exact technician command and evidence', async () => {
    const received = receivedIntent();
    const { service, manager } = setup(received);
    const actor = { id: 'tech-1', role: Role.TECHNICIAN };
    const request = { intentId: 'intent-1', commandId, receivedAmountVnd: 120_000, receiptEvidenceUrl: 'evidence-1' };
    expect(await (service as any).receiveCashIntent('SOLO', 'order-1', request, actor)).toBe(received);
    await expect((service as any).receiveCashIntent('SOLO', 'order-1',
      { ...request, receiptEvidenceUrl: 'different' }, actor)).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
  });
});
