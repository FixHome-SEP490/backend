import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isUUID, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BookingStatus, CheckInResult, PaymentStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TechnicianReportService } from './technician-report.service';
import { OnsiteInterruptionController } from './onsite-interruption.controller';
import { SoloContactAttemptDto } from './dto/solo-contact.dto';
import { CannotContinueDto } from './dto/technician-report.dto';
import { SOLO_CONTACT } from '../service-orders/onsite-contact';
import { PERMISSION_KEY, ROLES_KEY } from '../../common/decorators';
import { ONSITE_INTERRUPTION_ACTION, ONSITE_STOP_ACTION } from '../service-orders/onsite-interruption';
import { ServiceOrdersService } from '../service-orders/service-orders.service';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { RISK_RATE_LIMITS } from '../../common/rate-limit/risk-rate-limit';

// Real services, serialized/rollback persistence double. Not PostgreSQL lock/race proof.
describe('solo no-show evidence and operational release', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-04T03:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  it.each(['customer_absent', 'customer_unreachable'])('releases once for %s while SM review stays pending, preserving money/parts/customer', async reasonCode => {
    const h = setup(); h.command.reasonCode = reasonCode;
    h.rows.PartCustody = [{ id: randomUUID(), quantity: 3, returned: 0 }];
    const preserved = structuredClone([h.rows.ServiceOrder, h.rows.Booking, h.rows.PartCustody, h.rows.User]);
    await h.qualify();
    const contacts = structuredClone(h.rows.AuditLog);
    const [result, replay] = await Promise.all([h.stop(), h.stop()]);
    expect(result).toEqual(replay);
    expect(result).toMatchObject({ workStopped: true, assignmentReleased: true, terminalTransitionApplied: false,
      customerContinuation: { eligible: true }, oldObligations: { moneyPreserved: true, partsPreserved: true } });
    expect(h.rows.TechnicianAssignment[0]).toMatchObject({ isActive: false, unassignReason: ONSITE_STOP_ACTION });
    expect(h.rows.SupportCase).toHaveLength(1);
    expect(h.rows.SupportCase[0]).toMatchObject({ status: 'open', responsibility: 'pending_sm_review', reasonCode });
    expect(h.rows.AuditLog.filter(r => r.action === ONSITE_INTERRUPTION_ACTION)).toHaveLength(1);
    expect(h.rows.AuditLog.filter(r => r.action === ONSITE_STOP_ACTION)).toHaveLength(1);
    expect(h.rows.AuditLog.find(r => r.action === ONSITE_INTERRUPTION_ACTION).after.contactEvidenceIds.sort())
      .toEqual(contacts.map(r => r.id).sort());
    expect(h.rows.AuditLog.filter(r => r.action === SOLO_CONTACT)).toEqual(contacts);
    expect(h.rows.Notification.filter(r => r.type === ONSITE_INTERRUPTION_ACTION)).toHaveLength(3);
    expect([h.rows.ServiceOrder, h.rows.Booking, h.rows.PartCustody, h.rows.User]).toEqual(preserved);
    expect(h.reputation.penalize).not.toHaveBeenCalled(); expect(h.reputation.penalizeReviewedCase).not.toHaveBeenCalled();
    await expect(h.stop({ ...h.command, reason: 'Different replay payload' })).rejects.toThrow();
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
    expect(await h.stop()).toEqual(result); // Expiry cannot revoke exact historical readback.
  });

  it('records contacts durably with server time and idempotent notices', async () => {
    const h = setup(); const commandId = randomUUID();
    const first = await h.contact('CALL_ATTEMPT', commandId);
    expect(first).toMatchObject({ contactCount: 1, callConnectionVerified: false, ready: false });
    expect(new Date(first.recordedAt).getTime()).toBe(Date.now());
    expect(await h.contact('CALL_ATTEMPT', commandId)).toEqual(first);
    const noticeId = randomUUID(); await h.contact('IN_APP_NOTIFICATION', noticeId); await h.contact('IN_APP_NOTIFICATION', noticeId);
    expect(h.rows.AuditLog).toHaveLength(2); expect(h.rows.Notification).toHaveLength(1);
    await expect(h.contact('IN_APP_NOTIFICATION', randomUUID())).rejects.toThrow();
    expect(h.rows.AuditLog).toHaveLength(2); expect(h.rows.Notification).toHaveLength(1);
    const restarted = new TechnicianReportService(h.dataSource as never, new AuditLogService({} as never), h.reputation as never);
    expect(await restarted.contactReadiness(h.order.id, h.tech)).toMatchObject({ contactCount: 1, notificationSent: true, ready: false });
    await expect(h.contact('CALL_ATTEMPT', noticeId)).rejects.toThrow();
  });

  it.each(['already_ended', 'ends_while_waiting'])('releases an active onsite matched order when booked slot %s', async timing => {
    const h = setup();
    h.booking.preferredEndAt = new Date(Date.now() + (timing === 'already_ended' ? -3600000 : 1));
    expect(await h.service.contactReadiness(h.order.id, h.tech)).toMatchObject({ contactCount: 0, ready: false });
    await h.qualify();
    expect(await h.service.contactReadiness(h.order.id, h.tech)).toMatchObject({ contactCount: 2, ready: true });
    expect(await h.stop()).toMatchObject({ workStopped: true, assignmentReleased: true });
    expect(h.rows.SupportCase).toHaveLength(1);
    expect(h.rows.SupportCase[0]).toMatchObject({ responsibility: 'pending_sm_review' });
  });

  it('does not count concurrent retries as two calls', async () => {
    const h = setup(); const commandId = randomUUID();
    const [first, replay] = await Promise.all([h.contact('CALL_ATTEMPT', commandId), h.contact('CALL_ATTEMPT', commandId)]);
    expect(replay.evidenceId).toBe(first.evidenceId); expect(replay.contactCount).toBe(1);
    expect(h.rows.AuditLog).toHaveLength(1);
  });

  it('fails closed when immutable contact evidence referenced by a stop receipt is missing', async () => {
    const h = setup(); await h.qualify(); await h.stop();
    h.rows.AuditLog = h.rows.AuditLog.filter(row => row.action !== SOLO_CONTACT || row.after.kind !== 'CALL_ATTEMPT');
    const before = structuredClone(h.rows);
    await expect(h.stop()).rejects.toThrow(); expect(h.rows).toEqual(before);
    expect(await h.service.customerContinuation(h.order.id, h.customer)).toMatchObject({ customerContinuation: { eligible: false } });
  });

  it.each(['no_calls', 'one_call', '299_seconds', '599_seconds', 'no_notice', 'deleted_notice', 'notice_wrong_customer',
    'other_actor_evidence', 'other_order_evidence', 'group_evidence', 'old_assignment', 'future_call', 'before_checkin'])
    ('fails closed without sufficient same-scope evidence: %s', async state => {
      const h = setup();
      if (state !== 'no_calls') await h.contact('CALL_ATTEMPT');
      if (!['no_calls', 'one_call'].includes(state)) {
        vi.setSystemTime(Date.now() + (state === '299_seconds' ? 299000 : 300000)); await h.contact('CALL_ATTEMPT');
        if (state !== 'no_notice') await h.contact('IN_APP_NOTIFICATION');
        vi.setSystemTime(Date.now() + (state === '599_seconds' ? 299000 : state === '299_seconds' ? 301000 : 300000));
      }
      if (state === 'deleted_notice') h.rows.Notification = [];
      if (state === 'notice_wrong_customer') h.rows.Notification[0].userId = randomUUID();
      if (state === 'other_actor_evidence') h.rows.AuditLog.forEach(r => r.actorUserId = randomUUID());
      if (state === 'other_order_evidence') h.rows.AuditLog.forEach(r => r.after.orderId = randomUUID());
      if (state === 'group_evidence') h.rows.AuditLog.forEach(r => r.resourceType = 'visit_group');
      if (state === 'old_assignment') h.assignment.id = randomUUID();
      if (state === 'future_call') h.rows.AuditLog[1].createdAt = new Date(Date.now() + 1);
      if (state === 'before_checkin') h.rows.AuditLog[0].createdAt = new Date('2000-01-01');
      const before = structuredClone(h.rows);
      await expect(h.stop()).rejects.toThrow(); expect(h.rows).toEqual(before);
    });

  it.each(['inactive', 'another_technician', 'duplicate_assignment', 'missing_checkin', 'old_checkin', 'future_checkin',
    'out_of_radius', 'low_accuracy', 'group_child', 'orphan_group_item', 'expired_closed', 'expired_cancelled', 'closed',
    'paid', 'refunded', 'unknown_payment', 'invoice', 'completed', 'cancelled', 'accepted', 'completion_requested'])
    ('rejects unsafe contact, readiness and stop: %s', async state => {
      const h = setup(); await h.qualify();
      if (state === 'inactive') h.assignment.isActive = false;
      if (state === 'another_technician') h.assignment.technicianId = randomUUID();
      if (state === 'duplicate_assignment') h.rows.TechnicianAssignment.push({ ...h.assignment, id: randomUUID() });
      if (state === 'missing_checkin') h.rows.ArrivalCheckIn = [];
      if (state === 'old_checkin') h.checkin.checkedInAt = new Date('2000-01-01');
      if (state === 'future_checkin') h.checkin.checkedInAt = new Date(Date.now() + 1);
      if (state === 'out_of_radius') h.checkin.result = CheckInResult.OUT_OF_GEOFENCE;
      if (state === 'low_accuracy') h.checkin.result = CheckInResult.LOW_ACCURACY;
      if (state === 'group_child') h.booking.visitGroupId = randomUUID();
      if (state === 'orphan_group_item') h.rows.VisitGroupItem = [{ bookingId: h.booking.id, groupId: randomUUID() }];
      if (state.startsWith('expired_')) h.booking.preferredEndAt = new Date(Date.now() - 3600000);
      if (state === 'expired_closed') h.booking.status = BookingStatus.CLOSED;
      if (state === 'expired_cancelled') h.order.status = ServiceOrderStatus.CANCELLED;
      if (state === 'closed') h.booking.status = BookingStatus.CLOSED;
      if (['paid', 'refunded', 'unknown_payment'].includes(state)) h.order.paymentStatus = state as any;
      if (state === 'invoice') h.rows.Invoice = [{ serviceOrderId: h.order.id, grandTotal: 500000 }];
      if (['completed', 'cancelled', 'accepted'].includes(state)) h.order.status = state as any;
      if (state === 'completion_requested') h.order.completionRequestedAt = new Date();
      const before = structuredClone(h.rows);
      await expect(h.contact('CALL_ATTEMPT')).rejects.toThrow();
      await expect(h.service.contactReadiness(h.order.id, h.tech)).rejects.toThrow();
      await expect(h.stop()).rejects.toThrow(); expect(h.rows).toEqual(before);
    });

  it.each([Role.CUSTOMER, Role.SERVICE_MANAGER, Role.ADMIN, Role.TECHNICIAN])('denies wrong role/ownership %s', async role => {
    const h = setup(); await h.qualify(); const actor = { id: randomUUID(), role };
    const before = structuredClone(h.rows);
    await expect(h.contact('CALL_ATTEMPT', randomUUID(), actor)).rejects.toThrow();
    await expect(h.service.contactReadiness(h.order.id, actor)).rejects.toThrow();
    await expect(h.stop(h.command, actor)).rejects.toThrow(); expect(h.rows).toEqual(before);
  });

  it('cannot use a synthetic groupCommandId to bypass solo evidence', async () => {
    const h = setup(); const before = structuredClone(h.rows);
    await expect(h.dataSource.transaction(m => h.service.stopWithinTransaction(m, h.order.id, h.command as CannotContinueDto, h.tech, randomUUID())))
      .rejects.toThrow();
    expect(h.rows).toEqual(before);
  });

  it('rejects fabricated client evidence even through direct service entry', async () => {
    const h = setup(); const before = structuredClone(h.rows);
    const input = { ...h.command, callTimes: ['2000-01-01', '2000-01-02'], notificationSent: true };
    await expect(h.stop(input)).rejects.toMatchObject({ response: { code: 'SOLO_CONTACT_NOT_READY' } });
    expect(h.rows).toEqual(before);
  });

  it('does not finalize an incomplete no-show receipt even after contact requirements later become ready', async () => {
    const h = setup(); await h.qualify(); await h.stop();
    h.rows.AuditLog = h.rows.AuditLog.filter(row => row.action !== ONSITE_STOP_ACTION);
    h.assignment.isActive = true; h.assignment.unassignedAt = null; h.assignment.unassignReason = null;
    const before = structuredClone(h.rows);
    await expect(h.stop()).rejects.toThrow(); expect(h.rows).toEqual(before);
  });

  it('preserves completion when its serialized transaction wins the stop race', async () => {
    const h = setup(); await h.qualify();
    const orders = Object.assign(Object.create(ServiceOrdersService.prototype), { dataSource: h.dataSource,
      assertCompletionReady: vi.fn(async () => undefined), notifyCustomerForOrder: vi.fn(async () => undefined),
      generateInvoice: vi.fn(async (id: string, manager: any) => manager.insert(Invoice, { id: randomUUID(), serviceOrderId: id, grandTotal: 500000 })),
      auditLogService: new AuditLogService({} as never) }) as ServiceOrdersService;
    const results = await Promise.allSettled([orders.requestCompletion(h.order.id, {}, h.tech), h.stop()]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(h.rows.Invoice).toHaveLength(1); expect(h.rows.SupportCase).toHaveLength(0);
    expect(h.assignment.isActive).toBe(true); expect(h.order.completionRequestedAt).toBeTruthy();
  });

  it('blocks completion when stop wins the serialized transaction race', async () => {
    const h = setup(); await h.qualify();
    const orders = Object.assign(Object.create(ServiceOrdersService.prototype), { dataSource: h.dataSource }) as ServiceOrdersService;
    const results = await Promise.allSettled([h.stop(), orders.requestCompletion(h.order.id, {}, h.tech)]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(h.rows.SupportCase).toHaveLength(1); expect(h.rows.Invoice ?? []).toHaveLength(0);
  });

  it('also enforces evidence for direct ambient solo stops', async () => {
    const h = setup();
    await expect(h.dataSource.transaction(m => h.service.stopWithinTransaction(m, h.order.id, h.command as CannotContinueDto, h.tech))).rejects.toThrow();
    await h.qualify();
    expect(await h.dataSource.transaction(m => h.service.stopWithinTransaction(m, h.order.id, h.command as CannotContinueDto, h.tech)))
      .toMatchObject({ workStopped: true });
  });

  it('serializes distinct stop commands to one receipt and case', async () => {
    const h = setup(); await h.qualify();
    const result = await Promise.allSettled([h.stop(), h.stop({ ...h.command, commandId: randomUUID() })]);
    expect(result.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(h.rows.SupportCase).toHaveLength(1);
    expect(h.rows.AuditLog.filter(r => r.action === ONSITE_STOP_ACTION)).toHaveLength(1);
  });

  it.each(['receipt', 'finalization', 'notification'])('rolls back stop on %s storage failure', async failure => {
    const h = setup(); await h.qualify(); const before = structuredClone(h.rows);
    const insert = h.manager.insert.getMockImplementation();
    h.manager.insert.mockImplementation(async (entity: any, value: any) => {
      if ((failure === 'receipt' && value.action === ONSITE_INTERRUPTION_ACTION) ||
        (failure === 'finalization' && value.action === ONSITE_STOP_ACTION) ||
        (failure === 'notification' && entity.name === 'Notification')) throw new Error('storage failed');
      return insert(entity, value);
    });
    await expect(h.stop()).rejects.toThrow('storage failed'); expect(h.rows).toEqual(before);
  });

  it('rolls back notice when contact audit fails', async () => {
    const h = setup(); const before = structuredClone(h.rows);
    h.manager.save.mockRejectedValue(new Error('audit failed'));
    await expect(h.contact('IN_APP_NOTIFICATION')).rejects.toThrow('audit failed'); expect(h.rows).toEqual(before);
  });

  it('rejects client identities, timestamps and group inputs at DTO boundary', async () => {
    const input = { commandId: randomUUID(), kind: 'CALL_ATTEMPT', userId: randomUUID(), orderId: randomUUID(),
      selectedOrderId: randomUUID(), recordedAt: '2000-01-01', notificationSent: true };
    const errors = await validate(plainToInstance(SoloContactAttemptDto, input), { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map(e => e.property).sort()).toEqual(['notificationSent', 'orderId', 'recordedAt', 'selectedOrderId', 'userId']);
    expect(await validate(plainToInstance(SoloContactAttemptDto, { commandId: 'bad', kind: 'CONNECTED' }))).toHaveLength(2);
  });

  it('rate-limits solo contact writes without throttling read-only readiness', () => {
    const bucket = (name: 'contactAttempt' | 'cannotContinue' | 'contactReadiness') => Reflect.getMetadata(
      'fixhome:risk-limit-bucket', OnsiteInterruptionController.prototype[name]);
    expect(bucket('contactAttempt')).toBe('onsite-contact');
    expect(bucket('cannotContinue')).toBe('onsite-stop');
    expect(bucket('contactReadiness')).toBeUndefined();
    expect(RISK_RATE_LIMITS['onsite-contact']).toEqual({ limit: 10, windowMs: 600000 });
  });

  it('keeps solo technician actions behind existing role/permission guards', () => {
    for (const method of [OnsiteInterruptionController.prototype.contactReadiness,
      OnsiteInterruptionController.prototype.contactAttempt, OnsiteInterruptionController.prototype.cannotContinue]) {
      expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual([Role.TECHNICIAN]);
      expect(Reflect.getMetadata(PERMISSION_KEY, method)).toEqual(['order:read_related']);
    }
  });
});

function setup() {
  const tech = { id: randomUUID(), role: Role.TECHNICIAN };
  const customer = { id: randomUUID(), role: Role.CUSTOMER };
  const booking = { id: randomUUID(), customerId: customer.id, status: BookingStatus.MATCHED, preferredEndAt: new Date('2026-11-05T00:00:00Z'), visitGroupId: null as string | null };
  const order = { id: randomUUID(), bookingId: booking.id, status: ServiceOrderStatus.UNDER_REPAIR,
    paymentStatus: PaymentStatus.UNPAID, completionRequestedAt: null, laborTotal: 300000, partsTotal: 200000, grandTotal: 500000 };
  const assignment = { id: randomUUID(), serviceOrderId: order.id, technicianId: tech.id, isActive: true,
    assignedAt: new Date('2026-10-29T01:00:00Z'), unassignedAt: null as Date | null, unassignReason: null as string | null };
  const checkin = { id: randomUUID(), serviceOrderId: order.id, technicianId: tech.id,
    lat: 10, lng: 106, accuracyMeters: 5, distanceMeters: 0, result: CheckInResult.VALID, checkedInAt: new Date('2026-10-29T02:00:00Z') };
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
  const command = { commandId: randomUUID() as string, reasonClass: 'non_technician_exception', reasonCode: 'customer_absent',
    reason: 'Không đủ kỹ năng để tiếp tục sửa thiết bị này', photoEvidenceIds: [] as string[] };
  const contact = (kind: 'CALL_ATTEMPT' | 'IN_APP_NOTIFICATION', commandId = randomUUID(), actor = tech) =>
    service.contactAttempt(order.id, { commandId, kind }, actor);
  const qualify = async () => {
    await contact('CALL_ATTEMPT'); vi.setSystemTime(Date.now() + 300000);
    await contact('CALL_ATTEMPT'); await contact('IN_APP_NOTIFICATION'); vi.setSystemTime(Date.now() + 300000);
  };
  const stop = (dto = command, actor = tech) => (service as any).cannotContinue(order.id, dto, actor);
  const eligibility = (actor = customer) => (service as any).customerContinuation(order.id, actor);
  return { rows, manager, dataSource, operations, tech, customer, booking, order, assignment, checkin, reputation,
    service, command, stop, eligibility, contact, qualify };
}
