import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isUUID, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BookingStatus, CheckInResult, PaymentStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TechnicianReportService } from './technician-report.service';
import { contactReadiness, GROUP_CONTACT, GROUP_STOP, GroupStopService } from './group-stop.service';
import { GroupContactAttemptDto, GroupStopDto } from './dto/group-stop.dto';
import { groupStopCorrelations } from './group-stop-read';
import { GroupStopController } from './group-stop.controller';
import { PERMISSION_KEY, ROLES_KEY } from '../../common/decorators';
import { ServiceOrdersService } from '../service-orders/service-orders.service';
import { Invoice } from '../service-orders/entities/invoice.entity';

describe('group stop transaction (persistence double, not PostgreSQL race proof)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-01T02:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  function setup(deviceCount = 3) {
    const h = groupFixture();
    const groupId = randomUUID();
    h.rows.VisitGroup = [{ id: groupId, customerId: h.customer.id }];
    h.rows.VisitGroupItem = [];
    for (let i = 0; i < deviceCount; i++) {
      const booking = i === 0 ? h.booking : { ...h.booking, id: randomUUID() };
      booking.visitGroupId = groupId;
      const order = i === 0 ? h.order : { ...h.order, id: randomUUID(), bookingId: booking.id };
      if (i > 0) {
        h.rows.Booking.push(booking); h.rows.ServiceOrder.push(order);
        h.rows.TechnicianAssignment.push({ ...h.assignment, id: randomUUID(), serviceOrderId: order.id });
        h.rows.ArrivalCheckIn.push({ ...h.checkin, id: randomUUID(), serviceOrderId: order.id });
      }
      h.rows.VisitGroupItem.push({ id: randomUUID(), groupId, bookingId: booking.id, sequence: i + 1, outcome: null });
    }
    const service = new GroupStopService(h.dataSource as never, new AuditLogService({} as never), h.service);
    const input = { ...h.command, selectedOrderId: h.order.id, reasonClass: 'non_technician_exception', reasonCode: 'customer_absent' } as GroupStopDto;
    const contact = (kind: GroupContactAttemptDto['kind'], commandId = randomUUID(), actor = h.tech) => service.contact(groupId,
      { commandId, selectedOrderId: h.order.id, kind }, actor);
    const qualify = async () => {
      await contact('CALL_ATTEMPT'); vi.setSystemTime(Date.now() + 300000);
      await contact('CALL_ATTEMPT'); await contact('IN_APP_NOTIFICATION'); vi.setSystemTime(Date.now() + 300000);
    };
    return { ...h, groupId, group: service, input, contact, qualify, stopGroup: (body = input, actor = h.tech) => service.stop(groupId, body, actor) };
  }

  it('stores evidence durably, replays contact without increasing count or sending twice', async () => {
    const h = setup(); const command = randomUUID();
    const first = await h.contact('CALL_ATTEMPT', command);
    const replay = await h.contact('CALL_ATTEMPT', command);
    expect(replay.evidenceId).toBe(first.evidenceId); expect(replay.contactCount).toBe(1);
    expect(h.rows.AuditLog).toHaveLength(1); expect(first.callConnectionVerified).toBe(false);
    const notifyCommand = randomUUID(); await h.contact('IN_APP_NOTIFICATION', notifyCommand); await h.contact('IN_APP_NOTIFICATION', notifyCommand);
    expect(h.rows.Notification).toHaveLength(1);
    const restarted = new GroupStopService(h.dataSource as never, new AuditLogService({} as never), h.service);
    expect(await restarted.readiness(h.groupId, h.order.id, h.tech)).toMatchObject({ contactCount: 1, notificationSent: true, ready: false });
    await expect(h.contact('CALL_ATTEMPT', notifyCommand)).rejects.toThrow();
  });

  it.each([
    ['customer_absent', 4], ['customer_absent', 5],
    ['customer_unreachable', 4], ['customer_unreachable', 5],
  ])('stops all %i children once for %s, with separate cases and one logical grouped notification', async (reasonCode, deviceCount) => {
    const h = setup(deviceCount); await h.qualify();
    h.input.reasonCode = reasonCode as GroupStopDto['reasonCode'];
    const before = structuredClone(h.rows.ServiceOrder);
    const results = await Promise.all([h.stopGroup(), h.stopGroup()]);
    expect(results[1]).toEqual(results[0]); expect((results[0] as any).stopped).toHaveLength(deviceCount);
    expect(h.rows.SupportCase).toHaveLength(deviceCount); expect(new Set(h.rows.SupportCase.map(c => c.interruptionCommandId)).size).toBe(deviceCount);
    expect(h.rows.TechnicianAssignment.every(a => a.isActive === false)).toBe(true);
    expect(h.rows.VisitGroupItem.every(i => i.outcome === 'interrupted')).toBe(true);
    expect(h.rows.ServiceOrder).toEqual(before);
    expect(h.rows.AuditLog.filter(l => l.action === GROUP_STOP)).toHaveLength(1);
    expect(h.rows.Notification.filter(n => n.type === GROUP_STOP)).toHaveLength(3);
    const correlations = await groupStopCorrelations(h.manager, h.rows.SupportCase);
    expect(correlations.size).toBe(deviceCount);
    expect(new Set([...correlations.values()].map(c => c.commandId)).size).toBe(1);
    expect([...correlations.values()][0].childCaseIds).toHaveLength(deviceCount);
    await expect(h.stopGroup({ ...h.input, reason: 'Changed content in replay' })).rejects.toThrow();
    expect(await h.group.incidents(h.groupId, { id: randomUUID(), role: Role.ADMIN })).toHaveLength(1);
  });

  it.each(['customer_absent', 'customer_unreachable'])('stops three children once for %s, with separate cases and one logical grouped notification', async reasonCode => {
    const h = setup(); await h.qualify();
    h.input.reasonCode = reasonCode as GroupStopDto['reasonCode'];
    const before = structuredClone(h.rows.ServiceOrder);
    const results = await Promise.all([h.stopGroup(), h.stopGroup()]);
    expect(results[1]).toEqual(results[0]); expect((results[0] as any).stopped).toHaveLength(3);
    expect(h.rows.SupportCase).toHaveLength(3); expect(new Set(h.rows.SupportCase.map(c => c.interruptionCommandId)).size).toBe(3);
    expect(h.rows.TechnicianAssignment.every(a => a.isActive === false)).toBe(true);
    expect(h.rows.VisitGroupItem.every(i => i.outcome === 'interrupted')).toBe(true);
    expect(h.rows.ServiceOrder).toEqual(before);
    expect(h.rows.AuditLog.filter(l => l.action === GROUP_STOP)).toHaveLength(1);
    expect(h.rows.Notification.filter(n => n.type === GROUP_STOP)).toHaveLength(3);
    const correlations = await groupStopCorrelations(h.manager, h.rows.SupportCase);
    expect(correlations.size).toBe(3);
    expect(new Set([...correlations.values()].map(c => c.commandId)).size).toBe(1);
    expect([...correlations.values()][0].childCaseIds).toHaveLength(3);
    await expect(h.stopGroup({ ...h.input, reason: 'Changed content in replay' })).rejects.toThrow();
    expect(await h.group.incidents(h.groupId, { id: randomUUID(), role: Role.ADMIN })).toHaveLength(1);
  });

  it('rejects notification storage failure without recording contact evidence', async () => {
    const h = setup(); h.manager.insert.mockRejectedValue(new Error('notification unavailable'));
    await expect(h.contact('IN_APP_NOTIFICATION')).rejects.toThrow('notification unavailable');
    expect(h.rows.AuditLog).toHaveLength(0); expect(h.rows.Notification).toHaveLength(0);
  });

  it('preserves the completion writer that wins the serialized transaction race', async () => {
    const h = setup(); await h.qualify();
    const orders = Object.assign(Object.create(ServiceOrdersService.prototype), { dataSource: h.dataSource,
      assertCompletionReady: vi.fn(async () => undefined), notifyCustomerForOrder: vi.fn(async () => undefined),
      generateInvoice: vi.fn(async (id: string, manager: any) => manager.insert(Invoice, { id: randomUUID(), serviceOrderId: id, grandTotal: 123000 })),
      auditLogService: new AuditLogService({} as never) }) as ServiceOrdersService;
    const sibling = h.rows.ServiceOrder[1];
    const [_, result] = await Promise.all([orders.requestCompletion(sibling.id, {}, h.tech), h.stopGroup()]);
    expect((result as any).stopped).toHaveLength(2); expect((result as any).preserved[0].orderId).toBe(sibling.id);
    expect(h.rows.Invoice).toHaveLength(1); expect(sibling.completionRequestedAt).toBeTruthy();
  });

  it('refuses completion and cancellation after group stop wins, keeping receipts intact', async () => {
    const h = setup(); await h.qualify();
    h.rows.ServiceOrder.forEach(order => order.status = ServiceOrderStatus.EN_ROUTE);
    const orders = Object.assign(Object.create(ServiceOrdersService.prototype), { dataSource: h.dataSource }) as ServiceOrdersService;
    await h.stopGroup(); const before = structuredClone(h.rows);
    await expect(orders.requestCompletion(h.order.id, {}, h.tech)).rejects.toThrow();
    await expect(orders.cancelVisit(h.groupId, { reason: 'Concurrent customer cancellation request' }, h.customer)).rejects.toThrow();
    expect(h.rows).toEqual(before);
  });

  it.each(['completed', 'paid', 'completion_requested', 'terminal_outcome'])('preserves %s child and old finance/parts', async state => {
    const h = setup(); const child = h.rows.ServiceOrder[2];
    if (state === 'completed') child.status = ServiceOrderStatus.COMPLETED;
    if (state === 'paid') child.paymentStatus = PaymentStatus.PAID;
    if (state === 'completion_requested') child.completionRequestedAt = new Date();
    if (state === 'terminal_outcome') h.rows.VisitGroupItem[2].outcome = 'succeeded';
    h.rows.Invoice = [{ id: randomUUID(), serviceOrderId: child.id, grandTotal: 777000 }];
    h.rows.PartCustody = [{ id: randomUUID(), quantity: 3, returned: 0 }];
    const finance = structuredClone([h.rows.Invoice, h.rows.PartCustody, child]);
    await h.qualify(); const result: any = await h.stopGroup();
    expect(result.stopped).toHaveLength(2); expect(result.preserved).toHaveLength(1);
    expect([h.rows.Invoice, h.rows.PartCustody, child]).toEqual(finance);
    expect(h.rows.TechnicianAssignment[2].isActive).toBe(true);
  });

  it('preserves one paid child and stops the four unfinished children of a five-child group', async () => {
    const h = setup(5);
    const paid = h.rows.ServiceOrder[4];
    paid.status = ServiceOrderStatus.COMPLETED;
    paid.paymentStatus = PaymentStatus.PAID;
    paid.completionRequestedAt = new Date();
    h.rows.Invoice = [{ id: randomUUID(), serviceOrderId: paid.id, grandTotal: 777000 }];
    const paidBefore = structuredClone(paid);
    await h.qualify();

    const result: any = await h.stopGroup();
    expect(result.stopped).toHaveLength(4);
    expect(result.preserved).toHaveLength(1);
    expect(result.preserved[0]).toMatchObject({ orderId: paid.id, disposition: 'PRESERVED', financialFollowupRequired: true });
    expect(h.rows.ServiceOrder.find(order => order.id === paid.id)).toEqual(paidBefore);
    expect(h.rows.VisitGroupItem[4].outcome).toBeNull();
    expect(h.rows.TechnicianAssignment[4].isActive).toBe(true);
    expect(h.rows.TechnicianAssignment.slice(0, 4).every(assignment => assignment.isActive === false)).toBe(true);
    expect(h.rows.SupportCase).toHaveLength(4);
  });

  it.each(['no_calls', 'one_call', '299_seconds', '599_seconds', 'no_notification', 'deleted_notification', 'new_assignment', 'missing_checkin', 'inactive_child', 'preexisting_receipt', 'unknown_finance'])('fails closed: %s', async state => {
    const h = setup();
    if (state !== 'no_calls') await h.contact('CALL_ATTEMPT');
    if (state !== 'no_calls' && state !== 'one_call') {
      vi.setSystemTime(Date.now() + (state === '299_seconds' ? 299000 : 300000));
      await h.contact('CALL_ATTEMPT');
      if (state !== 'no_notification') await h.contact('IN_APP_NOTIFICATION');
      vi.setSystemTime(Date.now() + (state === '599_seconds' ? 299000 : state === '299_seconds' ? 301000 : 300000));
    }
    if (state === 'deleted_notification') h.rows.Notification = [];
    if (state === 'new_assignment') h.rows.TechnicianAssignment[0].id = randomUUID();
    if (state === 'missing_checkin') h.rows.ArrivalCheckIn = [];
    if (state === 'inactive_child') h.rows.TechnicianAssignment[1].isActive = false;
    if (state === 'unknown_finance') h.rows.Invoice = [{ id: randomUUID(), serviceOrderId: h.rows.ServiceOrder[1].id }];
    if (state === 'preexisting_receipt') await h.stop();
    const before = structuredClone(h.rows);
    await expect(h.stopGroup()).rejects.toThrow(); expect(h.rows).toEqual(before);
  });

  it.each(['child_receipt', 'group_receipt', 'notification'])('rolls back all children after %s failure', async failure => {
    const h = setup(); await h.qualify(); const before = structuredClone(h.rows);
    const insert = h.manager.insert.getMockImplementation();
    h.manager.insert.mockImplementation(async (entity: any, value: any) => {
      if ((failure === 'child_receipt' && value?.action === 'TECHNICIAN_ONSITE_STOP_FINALIZED') ||
        (failure === 'group_receipt' && value?.action === GROUP_STOP) || (failure === 'notification' && entity.name === 'Notification')) throw new Error('storage failed');
      return insert(entity, value);
    });
    await expect(h.stopGroup()).rejects.toThrow('storage failed'); expect(h.rows).toEqual(before);
  });

  it('rolls back a five-child stop after a later unfinished child fails, preserving the paid sibling', async () => {
    const h = setup(5);
    const paid = h.rows.ServiceOrder[4];
    paid.status = ServiceOrderStatus.COMPLETED;
    paid.paymentStatus = PaymentStatus.PAID;
    paid.completionRequestedAt = new Date();
    h.rows.Invoice = [{ id: randomUUID(), serviceOrderId: paid.id, grandTotal: 777000 }];
    await h.qualify();
    const before = structuredClone(h.rows);
    const insert = h.manager.insert.getMockImplementation();
    let childReceipts = 0;
    h.manager.insert.mockImplementation(async (entity: any, value: any) => {
      if (value?.action === 'TECHNICIAN_ONSITE_STOP_FINALIZED' && ++childReceipts === 2) {
        throw new Error('second child receipt unavailable');
      }
      return insert(entity, value);
    });

    await expect(h.stopGroup()).rejects.toThrow('second child receipt unavailable');
    expect(childReceipts).toBe(2);
    expect(h.rows).toEqual(before);
  });

  it('rejects actor mismatch, stale checkin, and client evidence timestamps', async () => {
    const h = setup(); await h.qualify();
    await expect(h.stopGroup(h.input, { id: randomUUID(), role: Role.TECHNICIAN })).rejects.toThrow();
    await expect(h.stopGroup(h.input, h.customer)).rejects.toThrow();
    await expect(h.group.incidents(h.groupId, h.tech)).rejects.toThrow();
    const errors = await validate(plainToInstance(GroupContactAttemptDto, { commandId: randomUUID(), selectedOrderId: h.order.id, kind: 'CALL_ATTEMPT', recordedAt: '2000-01-01' }), { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(1);
    h.rows.ArrivalCheckIn[0].checkedInAt = new Date('2000-01-01'); await expect(h.stopGroup()).rejects.toThrow();
  });

  it('keeps staff access and technician actions under existing permissions', () => {
    const proto = GroupStopController.prototype;
    expect(Reflect.getMetadata(ROLES_KEY, proto.incidents)).toEqual([Role.SERVICE_MANAGER, Role.ADMIN]);
    expect(Reflect.getMetadata(PERMISSION_KEY, proto.incidents)).toEqual(['support:read_all']);
    for (const method of [proto.contact, proto.readiness, proto.stop]) {
      expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual([Role.TECHNICIAN]);
      expect(Reflect.getMetadata(PERMISSION_KEY, method)).toEqual(['order:read_related']);
    }
  });
});

describe('group contact timing', () => {
  it.each([
    [[], false], [[0], false], [[0, 299000], false], [[0, 300000], true],
  ])('checks call spacing %j', (times, ready) => {
    expect(contactReadiness(times, true, 600000).ready).toBe(ready);
  });
  it('requires notification and 600 full seconds from first call', () => {
    expect(contactReadiness([0, 300000], false, 600000).ready).toBe(false);
    expect(contactReadiness([0, 300000], true, 599000).ready).toBe(false);
    expect(contactReadiness([0, 300000], true, 600000)).toMatchObject({ ready: true, contactCount: 2 });
  });
});

function groupFixture() {
  const tech = { id: randomUUID(), role: Role.TECHNICIAN };
  const customer = { id: randomUUID(), role: Role.CUSTOMER };
  const booking = { id: randomUUID(), customerId: customer.id, status: BookingStatus.MATCHED, visitGroupId: null as string | null };
  const order = { id: randomUUID(), bookingId: booking.id, status: ServiceOrderStatus.UNDER_REPAIR,
    paymentStatus: PaymentStatus.UNPAID, completionRequestedAt: null, laborTotal: 300000, partsTotal: 200000, grandTotal: 500000 };
  const assignment = { id: randomUUID(), serviceOrderId: order.id, technicianId: tech.id, isActive: true,
    assignedAt: new Date('2026-10-29T01:00:00Z'), unassignedAt: null as Date | null, unassignReason: null as string | null };
  const checkin = { id: randomUUID(), serviceOrderId: order.id, technicianId: tech.id,
    result: CheckInResult.VALID, checkedInAt: new Date('2026-10-29T02:00:00Z') };
  const rows: Record<string, any[]> = {
    Booking: [booking], ServiceOrder: [order], TechnicianAssignment: [assignment], ArrivalCheckIn: [checkin],
    SupportCase: [], AuditLog: [], Notification: [],
    User: [{ id: randomUUID(), role: Role.SERVICE_MANAGER, status: 'active', isActive: true },
      { id: randomUUID(), role: Role.ADMIN, status: 'active', isActive: true }],
  };
  const matches = (row: any, where: any): boolean => Array.isArray(where)
    ? where.some(w => matches(row, w))
    : Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
      if (value && typeof value === 'object' && '_type' in value) {
        if (value._type === 'in') return value._value.includes(row[key]);
        if (value._type === 'not') return row[key] !== value._value;
        if (value._type === 'isNull') return row[key] == null;
      }
      if (typeof value === 'string' && isUUID(value) && typeof row[key] === 'string') return row[key].toLowerCase() === value.toLowerCase();
      return row[key] === value;
    });
  const operations: Array<{ entity: string; lock?: string }> = [];
  const manager: any = {
    findOne: vi.fn(async (entity: any, options: any) => {
      operations.push({ entity: entity.name, lock: options.lock?.mode });
      return (rows[entity.name] ?? []).find(row => matches(row, options.where)) ?? null;
    }),
    findOneBy: vi.fn(async (entity: any, where: any) => (rows[entity.name] ?? []).find(row => matches(row, where)) ?? null),
    findOneByOrFail: async (entity: any, where: any) => {
      const row = (rows[entity.name] ?? []).find(row => matches(row, where));
      if (!row) throw new Error('fixture row not found');
      return row;
    },
    findOneOrFail: vi.fn(async (entity: any, options: any) => {
      const row = (rows[entity.name] ?? []).find(row => matches(row, options.where));
      if (!row) throw new Error('fixture row not found');
      return row;
    }),
    find: vi.fn(async (entity: any, options: any) => (rows[entity.name] ?? []).filter(row => matches(row, options?.where))),
    count: vi.fn(async (entity: any, options: any) => (rows[entity.name] ?? []).filter(row => matches(row, options?.where)).length),
    create: (_entity: any, value: any) => value,
    save: vi.fn(async (entity: any, value: any) => {
      const saved = { id: randomUUID(), createdAt: new Date(Date.now()), ...value };
      (rows[entity.name] ??= []).push(saved);
      return saved;
    }),
    insert: vi.fn(async (entity: any, value: any) => {
      for (const row of Array.isArray(value) ? value : [value]) (rows[entity.name] ??= []).push({ id: randomUUID(), createdAt: new Date(Date.now()), ...row });
    }),
    update: vi.fn(async (entity: any, where: any, value: any) => {
      const found = (rows[entity.name] ?? []).filter(row => matches(row, typeof where === 'string' ? { id: where } : where));
      found.forEach(row => Object.assign(row, value)); return { affected: found.length };
    }),
    query: vi.fn(async () => [{ id: checkin.id }]),
  };
  let tail = Promise.resolve();
  const dataSource = { manager, transaction: (work: (m: any) => unknown) => {
    const task = tail.then(async () => {
      const snapshot = structuredClone(rows);
      try { return await work(manager); }
      catch (error) { Object.keys(rows).forEach(key => delete rows[key]); Object.assign(rows, snapshot); throw error; }
    });
    tail = task.then(() => undefined, () => undefined);
    return task;
  } };
  const reputation = { penalizeReviewedCase: vi.fn(), penalize: vi.fn() };
  const service = new TechnicianReportService(dataSource as never, new AuditLogService({} as never), reputation as never);
  const command = { commandId: randomUUID() as string, reasonClass: 'technician_skill_gap', reasonCode: 'skill_gap',
    reason: 'Không đủ kỹ năng để tiếp tục sửa thiết bị này', photoEvidenceIds: [] as string[] };
  const stop = (dto = command, actor = tech) => (service as any).cannotContinue(order.id, dto, actor);
  const eligibility = (actor = customer) => (service as any).customerContinuation(order.id, actor);
  return { rows, manager, dataSource, operations, tech, customer, booking, order, assignment, checkin, reputation,
    service, command, stop, eligibility };
}
