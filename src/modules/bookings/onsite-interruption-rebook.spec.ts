import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FindOperator } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TechnicianReportService } from '../support-cases/technician-report.service';
import { BookingsService } from './bookings.service';
import { VisitGroupsService } from '../visit-groups/visit-groups.service';
import { RepairFailureVoucherEvidence } from '../vouchers/repair-failure-voucher-evidence';
import { technicianEligibility } from './technician-eligibility';
import { QuotationsService } from '../quotations/quotations.service';
import { TechnicianAssignmentService } from '../technician-assignment/technician-assignment.service';
import { BookingStatus, CheckInResult, PaymentStatus, Role, ServiceOrderStatus, ServicePricingMode } from '../../shared/enums';

/** Real command, proof, draft, confirmation, Booking.create and VisitGroup.create.
 * Only persistence/config are doubled. This is not PostgreSQL concurrency proof. */
function fixture(stopped = 1, grouped = false) {
  const customer = { id: randomUUID(), role: Role.CUSTOMER };
  const technician = { id: randomUUID(), role: Role.TECHNICIAN };
  const serviceId = randomUUID(); const addressId = randomUUID();
  const groupId = grouped ? randomUUID() : null;
  const rows: Record<string, any[]> = {
    User: [{ ...customer, bookingSuspendedUntil: null }, { ...technician }],
    Service: [{ id: serviceId, name: 'Synthetic service', code: 'QA_FIXED', isActive: true,
      pricingMode: ServicePricingMode.FIXED_PRICE, fixedPrice: 199000, description: 'Fresh catalog scope' }],
    Address: [{ id: addressId, userId: customer.id, line1: 'Synthetic test address', province: 'Hồ Chí Minh', district: 'Quận 1', lat: 10.1, lng: 106.1 }],
    Booking: [], ServiceOrder: [], TechnicianAssignment: [], ArrivalCheckIn: [],
    SupportCase: [], AuditLog: [], Notification: [], BookingMedia: [],
    VisitGroup: groupId ? [{ id: groupId, customerId: customer.id, addressId }] : [], VisitGroupItem: [],
    InterruptionRebook: [], InterruptionRebookSource: [],
  };
  for (let i = 0; i < (grouped ? 3 : 1); i++) {
    const bookingId = randomUUID(); const orderId = randomUUID();
    rows.Booking.push({ id: bookingId, customerId: customer.id, serviceId, addressId,
      visitGroupId: groupId, status: BookingStatus.MATCHED, quantity: 1, description: `Synthetic device ${i + 1}`,
      customerNote: 'Synthetic source note', deviceAttributesSnapshot: null, catalogV2PricingSnapshot: null,
      pricingModeSnapshot: ServicePricingMode.FIXED_PRICE, fixedUnitPriceSnapshot: 777000,
      preferredStartAt: new Date('2026-10-29T01:00:00Z'), preferredEndAt: new Date('2026-10-29T05:00:00Z') });
    rows.ServiceOrder.push({ id: orderId, bookingId, code: `FH-QA-${i}`, status: i < stopped ? ServiceOrderStatus.UNDER_REPAIR : ServiceOrderStatus.COMPLETED,
      paymentStatus: PaymentStatus.PAID, laborTotal: 777000, partsTotal: 400000, grandTotal: 1177000 });
    rows.TechnicianAssignment.push({ id: randomUUID(), serviceOrderId: orderId, technicianId: technician.id,
      isActive: true, assignedAt: new Date('2026-10-29T01:00:00Z') });
    rows.ArrivalCheckIn.push({ id: randomUUID(), serviceOrderId: orderId, technicianId: technician.id,
      result: CheckInResult.VALID, checkedInAt: new Date('2026-10-29T02:00:00Z') });
    if (groupId) rows.VisitGroupItem.push({ id: randomUUID(), groupId, bookingId, serviceId, sequence: i + 1,
      deviceLabel: `Device ${i + 1}`, outcome: i < stopped ? null : 'succeeded' });
  }
  const matches = (row: any, where: any): boolean => Array.isArray(where) ? where.some(w => matches(row, w))
    : Object.entries(where ?? {}).every(([key, value]) => value instanceof FindOperator
      ? value.type === 'in' ? value.value.includes(row[key]) : value.type === 'not' ? row[key] !== value.value : value.type === 'isNull' ? row[key] == null : false
      : row[key] === value);
  const table = (entity: { name: string }) => rows[entity.name] ??= [];
  const manager: any = {
    findOne: vi.fn(async (entity, options) => table(entity).find(row => matches(row, options?.where)) ?? null),
    findOneBy: vi.fn(async (entity, where) => table(entity).find(row => matches(row, where)) ?? null),
    find: vi.fn(async (entity, options) => table(entity).filter(row => matches(row, options?.where))
      .sort((a, b) => options?.order?.sequence ? a.sequence - b.sequence : 0)),
    count: vi.fn(async (entity, options) => table(entity).filter(row => matches(row, options?.where)).length),
    create: (entity, value) => ({ ...value, __entity: entity }),
    save: vi.fn(async (entity, input) => {
      const value = input ?? entity; const cls = input ? entity : value.__entity;
      const saveOne = (item: any) => {
        const { __entity: _entity, ...fields } = item;
        const saved = { id: randomUUID(), ...fields };
        const at = table(cls).findIndex(row => row.id === saved.id);
        if (at < 0) table(cls).push(saved); else table(cls)[at] = saved;
        return saved;
      };
      return Array.isArray(value) ? value.map(saveOne) : saveOne(value);
    }),
    insert: vi.fn(async (entity, input) => {
      for (const value of Array.isArray(input) ? input : [input]) table(entity).push({ id: randomUUID(), ...value });
    }),
    update: vi.fn(async (entity, where, fields) => {
      const affected = table(entity).filter(row => matches(row, typeof where === 'string' ? { id: where } : where));
      affected.forEach(row => Object.assign(row, fields)); return { affected: affected.length };
    }),
    getRepository: (entity: any) => ({
      create: (value: any) => manager.create(entity, value), save: (value: any) => manager.save(entity, value),
      findOneBy: (where: any) => manager.findOneBy(entity, where), find: (options: any) => manager.find(entity, options),
    }),
  };
  manager.findOneOrFail = async (entity, options) => {
    const row = await manager.findOne(entity, options); if (!row) throw new Error('Fixture row unavailable'); return row;
  };
  manager.findOneByOrFail = async (entity, where) => manager.findOneOrFail(entity, { where });
  let tail = Promise.resolve();
  const dataSource: any = { manager, getRepository: manager.getRepository, transaction: (work: (m: any) => unknown) => {
    const next = tail.then(async () => {
      const snapshot = structuredClone(rows);
      try { return await work(manager); } catch (error) {
        Object.keys(rows).forEach(key => delete rows[key]); Object.assign(rows, snapshot); throw error;
      }
    });
    tail = next.then(() => undefined, () => undefined); return next;
  } };
  const config = { getInt: async (_: string, fallback: number) => fallback, getString: async () => 'true' };
  const audit = new AuditLogService({} as never);
  const reports = new TechnicianReportService(dataSource, audit, {} as never);
  const bookings = Object.assign(Object.create(BookingsService.prototype), { dataSource, auditLogService: audit, configService: config,
    userRepo: manager.getRepository({ name: 'User' }), serviceRepo: manager.getRepository({ name: 'Service' }),
    addressRepo: manager.getRepository({ name: 'Address' }) }) as BookingsService;
  const groups = Object.assign(Object.create(VisitGroupsService.prototype), { dataSource, bookingsService: bookings,
    config, auditLogService: audit }) as VisitGroupsService;
  const anchorId = rows.Booking[0].id; const orderId = rows.ServiceOrder[0].id;
  const stop = async () => {
    for (const order of rows.ServiceOrder.slice(0, stopped)) await reports.cannotContinue(order.id, {
      commandId: randomUUID(), reasonClass: 'technician_skill_gap', reasonCode: 'skill_gap',
      reason: 'Synthetic onsite inability to complete repair', photoEvidenceIds: [],
    } as any, technician);
  };
  const submit = (dto: any, actor = customer, anchor = anchorId) => bookings.confirmInterruptionRebook(anchor, dto, actor,
    (body, owner, m) => groups.create(body, owner, m));
  const body = () => ({ idempotencyKey: `confirm-${randomUUID()}`, addressId, date: '2030-10-29', slot: 'afternoon' as const,
    items: rows.Booking.slice(0, stopped).map(booking => ({ sourceBookingId: booking.id,
      sourceCaseId: rows.SupportCase.find(c => c.bookingId === booking.id).id })) });
  return { rows, manager, reports, bookings, groups, customer, technician, anchorId, orderId, serviceId, addressId, stop, body, submit };
}

describe('verified onsite interruption customer self-service', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-29T05:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  it('opens a read-only owned prefill while SM case and old paid service remain open', async () => {
    const h = fixture(); await h.stop(); const before = structuredClone(h.rows);
    const draft = await h.bookings.interruptionDraft(h.anchorId, h.customer);
    expect(draft).toMatchObject({ targetKind: 'booking', requiresNewSchedule: true, requiresPricingRevalidation: true,
      address: { id: h.addressId }, confirmation: { available: true } });
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]).toMatchObject({ sourceBookingId: h.anchorId, description: 'Synthetic device 1' });
    expect(draft.items[0]).not.toHaveProperty('fixedUnitPriceSnapshot');
    expect(draft).not.toHaveProperty('date'); expect(draft).not.toHaveProperty('slot');
    expect(h.rows).toEqual(before);
    expect(await h.reports.customerContinuation(h.orderId, h.customer)).toMatchObject({
      customerContinuation: { eligible: true, prefilledRebookAvailable: true,
        draftPath: `/api/v1/bookings/${h.anchorId}/interruption-draft` } });
  });

  it('rejects SOLO cannot-continue after completion has already been requested', async () => {
    const h = fixture(); h.rows.ServiceOrder[0].completionRequestedAt = new Date('2026-10-29T04:00:00Z');
    await expect(h.stop()).rejects.toMatchObject({ status: 409 });
    expect(h.rows.SupportCase).toHaveLength(0); expect(h.rows.AuditLog).toHaveLength(0);
  });

  it('keeps an exact same-command replay idempotent after completion is requested', async () => {
    const h = fixture(); await h.stop();
    const request = structuredClone(h.rows.AuditLog[0].after.request);
    h.rows.ServiceOrder[0].completionRequestedAt = new Date('2026-10-29T04:30:00Z');
    const replay = await h.reports.cannotContinue(h.orderId, request, h.technician);
    expect(replay).toMatchObject({ incidentId: h.rows.SupportCase[0].id,
      serviceOutcome: 'VERIFIED_INTERRUPTION_RECORDED', terminalTransitionApplied: false });
    expect(h.rows.SupportCase).toHaveLength(1); expect(h.rows.AuditLog).toHaveLength(2);
  });

  it('rejects a different command after completion even when a receipt already exists', async () => {
    const h = fixture(); await h.stop();
    const request = h.rows.AuditLog[0].after.request;
    h.rows.ServiceOrder[0].completionRequestedAt = new Date('2026-10-29T04:30:00Z');
    await expect(h.reports.cannotContinue(h.orderId, { ...request, commandId: randomUUID() }, h.technician))
      .rejects.toMatchObject({ status: 409 });
    expect(h.rows.SupportCase).toHaveLength(1); expect(h.rows.AuditLog).toHaveLength(2);
  });

  it('denies every manager interruption action on a recorded receipt without mutation or replay', async () => {
    const h = fixture(); await h.stop(); const before = structuredClone(h.rows);
    const assignments = Object.assign(Object.create(TechnicianAssignmentService.prototype), {
      dataSource: { transaction: (run: any) => run(h.manager) },
    }) as TechnicianAssignmentService;
    const manager = { id: randomUUID(), role: Role.SERVICE_MANAGER };
    for (const action of ['DIRECT_REASSIGN_SOLO', 'CLOSE_FOR_REBOOK', 'REJECT_REQUEST'] as const) {
      const dto = { commandId: randomUUID(), expectedCaseVersion: 0, action,
        reason: 'Quản lý đối soát gián đoạn tại nhà khách',
        ...(action === 'DIRECT_REASSIGN_SOLO' ? { technicianId: randomUUID() } : {}) };
      await expect(assignments.resolveInterruption(h.rows.SupportCase[0].id, dto as any, manager))
        .rejects.toMatchObject({ status: 409 });
      expect(h.rows).toEqual(before);
    }
  });

  it('does not offer manager rejection of a recorded technician service interruption', async () => {
    const h = fixture(); await h.stop();
    const assignments = Object.assign(Object.create(TechnicianAssignmentService.prototype), {
      dataSource: { manager: h.manager },
    }) as TechnicianAssignmentService;
    const options = await assignments.replacementOptions(h.rows.SupportCase[0].id, { id: randomUUID(), role: Role.SERVICE_MANAGER });
    expect(options.actions.REJECT_REQUEST).toEqual({ allowed: false, reasons: ['VERIFIED_ONSITE_INTERRUPTION'] });
  });

  it.each([false, true])('locks booking/group before order when rejecting a quote (group: %s)', async grouped => {
    const h = fixture(1, grouped); h.rows.ServiceOrder[0].status = ServiceOrderStatus.EN_ROUTE;
    const quote = { id: randomUUID(), serviceOrderId: h.orderId, technicianId: h.technician.id, status: 'sent', items: [] };
    h.rows.Quotation = [quote];
    const quotes = Object.assign(Object.create(QuotationsService.prototype), {
      dataSource: { transaction: (run: any) => run(h.manager) },
      quotationRepo: { findOneBy: async () => quote }, auditLogService: new AuditLogService({} as never),
    }) as QuotationsService;
    await quotes.decideQuotation(quote.id, 'REJECT', h.customer);
    const locks = h.manager.findOne.mock.calls.filter(([, options]) => options?.lock).map(([entity]) => entity.name);
    expect(locks.slice(0, grouped ? 4 : 2)).toEqual(grouped
      ? ['Booking', 'VisitGroup', 'Booking', 'ServiceOrder'] : ['Booking', 'ServiceOrder']);
  });

  it.each([1, 2, 3])('confirms exactly %i stopped group children using fresh create/pricing and no old money transfer', async stopped => {
    const h = fixture(stopped, true); await h.stop();
    const oldBookings = structuredClone(h.rows.Booking); const oldOrders = structuredClone(h.rows.ServiceOrder);
    const oldItems = structuredClone(h.rows.VisitGroupItem); const oldAssignments = structuredClone(h.rows.TechnicianAssignment);
    const draft = await h.bookings.interruptionDraft(h.anchorId, h.customer);
    expect(draft.targetKind).toBe(stopped === 1 ? 'booking' : 'visit_group');
    expect(draft.items).toHaveLength(stopped);
    const dto = h.body(); const result = await h.submit(dto);
    expect(result.targetKind).toBe(stopped === 1 ? 'booking' : 'visit_group');
    const targets = h.rows.Booking.slice(3);
    expect(targets).toHaveLength(stopped);
    for (const target of targets) {
      expect(target).toMatchObject({ customerId: h.customer.id, fixedUnitPriceSnapshot: 199000,
        status: 'submitted', bookingMode: 'scheduled', slot: 'afternoon', quantity: 1 });
      expect(target.preferredStartAt).toEqual(new Date('2030-10-29T06:00:00Z'));
      expect(target.visitGroupId == null).toBe(stopped === 1);
    }
    expect(h.rows.Booking.slice(0, 3)).toEqual(oldBookings);
    expect(h.rows.ServiceOrder).toEqual(oldOrders);
    expect(h.rows.TechnicianAssignment).toEqual(oldAssignments);
    expect(h.rows.VisitGroupItem.slice(0, 3)).toEqual(oldItems);
    expect(h.rows.InterruptionRebookSource).toHaveLength(stopped);
    expect(h.rows.InterruptionRebookSource.every(s => s.previousTechnicianId === h.technician.id)).toBe(true);
    expect(await h.submit(dto)).toEqual(result);
    expect(h.rows.Booking).toHaveLength(3 + stopped);
  });

  it('makes a consumed source unavailable while preserving exact confirm replay', async () => {
    const h = fixture(); await h.stop(); const dto = h.body(); const first = await h.submit(dto);
    expect(await h.reports.customerContinuation(h.orderId, h.customer)).toMatchObject({
      customerContinuation: { eligible: true, prefilledRebookAvailable: false } });
    await expect(h.bookings.interruptionDraft(h.anchorId, h.customer)).rejects.toThrow();
    await expect(h.submit({ ...dto, idempotencyKey: `new-${randomUUID()}` })).rejects.toThrow();
    await expect(h.submit({ ...dto, date: '2030-10-30' })).rejects.toThrow();
    expect(await h.submit(dto)).toEqual(first);
    expect(h.rows.Booking).toHaveLength(2);
  });

  it('ignores SM case status for an otherwise unchanged verified source', async () => {
    const h = fixture(); await h.stop(); h.rows.SupportCase[0].status = 'rejected'; h.rows.SupportCase[0].holdCompletion = false;
    expect((await h.bookings.interruptionDraft(h.anchorId, h.customer)).items).toHaveLength(1);
    await h.submit(h.body()); expect(h.rows.Booking).toHaveLength(2);
  });

  it('denies foreign customers and all other actor roles before any creation', async () => {
    const h = fixture(); await h.stop();
    for (const actor of [{ id: randomUUID(), role: Role.CUSTOMER }, h.technician,
      { id: h.customer.id, role: Role.ADMIN }, { id: h.customer.id, role: Role.SERVICE_MANAGER }]) {
      await expect(h.bookings.interruptionDraft(h.anchorId, actor)).rejects.toThrow();
      await expect(h.submit(h.body(), actor)).rejects.toThrow();
    }
    expect(h.rows.Booking).toHaveLength(1);
  });

  it.each(['report_only', 'no_receipt', 'invalid_receipt', 'changed_assignment', 'changed_checkin', 'changed_source_case'])('denies source %s', async kind => {
    const h = fixture(); await h.stop();
    if (kind === 'report_only' || kind === 'no_receipt') h.rows.AuditLog = [];
    if (kind === 'invalid_receipt') h.rows.AuditLog[0].after.version = 999;
    if (kind === 'changed_assignment') h.rows.TechnicianAssignment[0].technicianId = randomUUID();
    if (kind === 'changed_checkin') h.rows.ArrivalCheckIn[0].result = CheckInResult.FAILED;
    if (kind === 'changed_source_case') h.rows.SupportCase[0].customerId = randomUUID();
    await expect(h.bookings.interruptionDraft(h.anchorId, h.customer)).rejects.toThrow();
    await expect(h.submit(h.body())).rejects.toThrow(); expect(h.rows.Booking).toHaveLength(1);
  });

  it('rejects a missing/extra sibling or a different source case after prefill', async () => {
    const h = fixture(2, true); await h.stop(); const dto = h.body();
    await expect(h.submit({ ...dto, items: dto.items.slice(0, 1) })).rejects.toThrow();
    await expect(h.submit({ ...dto, items: [...dto.items, { sourceBookingId: h.rows.Booking[2].id, sourceCaseId: randomUUID() }] })).rejects.toThrow();
    await expect(h.submit({ ...dto, items: dto.items.map(item => ({ ...item, sourceCaseId: randomUUID() })) })).rejects.toThrow();
    expect(h.rows.Booking).toHaveLength(3);
  });

  it('does not grant manager-close authority to a group child with no interrupted outcome', async () => {
    const h = fixture(1, true); await h.stop(); h.rows.AuditLog = [];
    h.rows.Booking[0].status = BookingStatus.CANCELLED; h.rows.ServiceOrder[0].status = ServiceOrderStatus.CANCELLED;
    h.rows.VisitGroupItem[0].outcome = null;
    h.rows.SupportCase[0].status = 'resolved'; h.rows.SupportCase[0].resolutionCode = 'interrupted_for_rebook';
    await expect(h.bookings.interruptionDraft(h.anchorId, h.customer)).rejects.toThrow();
  });

  it.each(['missing_schedule', 'past_schedule', 'foreign_address', 'inactive_service', 'invalid_price', 'suspended_customer'])('fails new-booking validation for %s without consuming the source', async kind => {
    const h = fixture(); await h.stop(); const dto: any = h.body();
    if (kind === 'missing_schedule') delete dto.date;
    if (kind === 'past_schedule') dto.date = '2020-10-29';
    if (kind === 'foreign_address') dto.addressId = randomUUID();
    if (kind === 'inactive_service') h.rows.Service[0].isActive = false;
    if (kind === 'invalid_price') h.rows.Service[0].fixedPrice = null;
    if (kind === 'suspended_customer') h.rows.User[0].bookingSuspendedUntil = new Date('2031-01-01T00:00:00Z');
    await expect(h.submit(dto)).rejects.toThrow();
    expect(h.rows.Booking).toHaveLength(1); expect(h.rows.InterruptionRebookSource).toHaveLength(0);
  });

  it('preserves original invoice/payment/voucher/parts and one old group payment during rebook', async () => {
    const h = fixture(1, true); await h.stop();
    for (const table of ['Invoice', 'Payment', 'CashPaymentIntent', 'CashSettlement', 'VoucherReservation', 'VoucherPaymentLink', 'PartRequest', 'PartCustody', 'VisitGroupPayment']) {
      h.rows[table] = [{ id: randomUUID(), serviceOrderId: h.orderId, scopeId: h.rows.Booking[0].visitGroupId,
        state: { usedQty: 1, managerAcceptedQty: 0, outstandingQty: 2 }, status: 'pending' }];
    }
    const before = structuredClone(h.rows); await h.submit(h.body());
    for (const table of Object.keys(before).filter(name => !['Booking', 'AuditLog', 'InterruptionRebook', 'InterruptionRebookSource'].includes(name))) {
      expect(h.rows[table]).toEqual(before[table]);
    }
  });

  it('excludes the original technician through the existing matching authority after confirmation', async () => {
    const h = fixture(); await h.stop(); const result = await h.submit(h.body());
    h.manager.createQueryBuilder = () => ({ innerJoin() { return this; }, where() { return this; }, getCount: async () => 0 });
    const target = h.rows.Booking.find(row => row.id === result.bookingId);
    expect(await technicianEligibility(h.manager, h.technician.id, target)).toMatchObject({ eligible: false,
      reason: 'Previous technician is excluded from this interrupted booking' });
  });

  it('serializes same/different confirm keys to one new booking (transaction-double simulation)', async () => {
    const h = fixture(); await h.stop(); const dto = h.body();
    const pair = await Promise.all([h.submit(dto), h.submit(dto)]); expect(pair[0]).toEqual(pair[1]);
    await expect(h.submit({ ...dto, idempotencyKey: `other-${randomUUID()}` })).rejects.toThrow();
    expect(h.rows.Booking).toHaveLength(2); expect(h.rows.InterruptionRebookSource).toHaveLength(1);
  });

  it('rolls back new booking creation if the source consumption receipt fails', async () => {
    const h = fixture(); await h.stop(); const insert = h.manager.insert.getMockImplementation();
    h.manager.insert.mockImplementation(async (entity, input) => {
      if (entity.name === 'InterruptionRebookSource') throw new Error('consumption receipt unavailable');
      return insert(entity, input);
    });
    await expect(h.submit(h.body())).rejects.toThrow('consumption receipt unavailable');
    expect(h.rows.Booking).toHaveLength(1); expect(h.rows.InterruptionRebook).toHaveLength(0);
  });

  it('does not mistake a T1 skill-gap interruption for proven genuine failed-visit voucher evidence', async () => {
    const h = fixture(); await h.stop();
    await expect(new RepairFailureVoucherEvidence().failure(h.manager, h.rows.SupportCase[0].id)).rejects.toThrow();
    expect(h.rows.VoucherClaim ?? []).toHaveLength(0);
  });
});
