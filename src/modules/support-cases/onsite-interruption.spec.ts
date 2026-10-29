import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { isUUID, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TechnicianReportService } from './technician-report.service';
import { authorizeOrder } from '../service-orders/order-access';
import { isCompletionHeld } from './completion-hold';
import { ServiceOrdersService } from '../service-orders/service-orders.service';
import { TechnicianAssignmentService } from '../technician-assignment/technician-assignment.service';
import { InterruptionAction } from '../technician-assignment/resolve-interruption.dto';
import { BookingStatus, CheckInResult, PaymentStatus, Role, ServiceOrderStatus, SupportCaseStatus } from '../../shared/enums';
import { CannotContinueDto, TechnicianReportDto } from './dto/technician-report.dto';
import { OnsiteInterruptionController } from './onsite-interruption.controller';
import { PERMISSION_KEY, ROLES_KEY } from '../../common/decorators';

// Persistence double only: real services/receipt checks run; PostgreSQL lock and
// provider races still require an isolated database, not this serialized harness.
function setup() {
  const tech = { id: randomUUID(), role: Role.TECHNICIAN };
  const customer = { id: randomUUID(), role: Role.CUSTOMER };
  const booking = { id: randomUUID(), customerId: customer.id, status: BookingStatus.MATCHED, visitGroupId: null as string | null };
  const order = { id: randomUUID(), bookingId: booking.id, status: ServiceOrderStatus.UNDER_REPAIR,
    paymentStatus: PaymentStatus.UNPAID, completionRequestedAt: null, laborTotal: 300000, partsTotal: 200000, grandTotal: 500000 };
  const assignment = { id: randomUUID(), serviceOrderId: order.id, technicianId: tech.id, isActive: true,
    assignedAt: new Date('2026-10-29T01:00:00Z') };
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
    findOneOrFail: vi.fn(async (entity: any, options: any) => {
      const row = (rows[entity.name] ?? []).find(row => matches(row, options.where));
      if (!row) throw new Error('fixture row not found');
      return row;
    }),
    find: vi.fn(async (entity: any, options: any) => (rows[entity.name] ?? []).filter(row => matches(row, options?.where))),
    count: vi.fn(async (entity: any, options: any) => (rows[entity.name] ?? []).filter(row => matches(row, options?.where)).length),
    create: (_entity: any, value: any) => value,
    save: vi.fn(async (entity: any, value: any) => {
      const saved = { id: randomUUID(), ...value };
      (rows[entity.name] ??= []).push(saved);
      return saved;
    }),
    insert: vi.fn(async (entity: any, value: any) => {
      for (const row of Array.isArray(value) ? value : [value]) (rows[entity.name] ??= []).push({ id: randomUUID(), ...row });
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
  const orders = Object.assign(Object.create(ServiceOrdersService.prototype), { dataSource }) as ServiceOrdersService;
  const assignments = Object.assign(Object.create(TechnicianAssignmentService.prototype), { dataSource }) as TechnicianAssignmentService;
  return { rows, manager, dataSource, operations, tech, customer, booking, order, assignment, checkin, reputation,
    service, command, stop, eligibility, orders, assignments };
}

describe('platform-first verified onsite interruption', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-29T05:00:00Z').getTime()));
  afterEach(() => vi.restoreAllMocks());

  it('records one verified interruption and allows independent customer booking while the case is OPEN', async () => {
    const h = setup();
    const result = await h.stop();
    expect(result).toMatchObject({ version: 1, serviceOutcome: 'VERIFIED_INTERRUPTION_RECORDED',
      serviceOrderStatus: 'under_repair', terminalTransitionApplied: false,
      customerContinuation: { eligible: true, independentNewBookingAllowed: true, prefilledRebookAvailable: false,
        requiresNewSchedule: true, requiresPricingRevalidation: true, requiresCustomerConfirmation: true } });
    expect(h.rows.SupportCase).toHaveLength(1);
    expect(h.rows.SupportCase[0]).toMatchObject({ status: 'open', holdCompletion: true, responsibility: 'pending_sm_review' });
    expect(h.rows.AuditLog).toHaveLength(1);
    expect(h.rows.Notification).toHaveLength(3);
    expect(h.rows.Notification.every(n => n.referenceType === 'SUPPORT_CASE' && n.referenceId === result.incidentId)).toBe(true);
    expect(h.rows.Booking).toHaveLength(1);
    expect(h.order.status).toBe(ServiceOrderStatus.UNDER_REPAIR);
    expect(h.assignment.isActive).toBe(true);
    expect(h.reputation.penalizeReviewedCase).not.toHaveBeenCalled();
    expect(h.reputation.penalize).not.toHaveBeenCalled();
    expect(await h.eligibility()).toEqual(result);
  });

  it.each([Role.CUSTOMER, Role.ADMIN, Role.SERVICE_MANAGER])('denies %s as the stopping actor', async role => {
    const h = setup();
    await expect(h.stop(h.command, { id: h.tech.id, role })).rejects.toThrow();
    expect(h.rows.AuditLog).toHaveLength(0);
  });

  it('denies a different technician and a changed or inactive assignment', async () => {
    const h = setup();
    await expect(h.stop(h.command, { id: randomUUID(), role: Role.TECHNICIAN })).rejects.toThrow();
    h.rows.TechnicianAssignment[0].isActive = false;
    await expect(h.stop()).rejects.toThrow();
    expect(h.rows.SupportCase).toHaveLength(0);
  });

  it.each(['missing', 'invalid', 'other_technician', 'before_assignment'])('denies %s check-in', async kind => {
    const h = setup();
    if (kind === 'missing') h.rows.ArrivalCheckIn = [];
    if (kind === 'invalid') h.checkin.result = 'invalid' as CheckInResult;
    if (kind === 'other_technician') h.checkin.technicianId = randomUUID();
    if (kind === 'before_assignment') h.checkin.checkedInAt = new Date('2026-10-29T00:00:00Z');
    await expect(h.stop()).rejects.toThrow();
    expect(h.rows.AuditLog).toHaveLength(0);
  });

  it.each([ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED])('denies stage %s', async status => {
    const h = setup(); h.order.status = status;
    await expect(h.stop()).rejects.toThrow();
    expect(h.rows.SupportCase).toHaveLength(0);
  });

  it('accepts valid checked-in EN_ROUTE without pretending repair has begun', async () => {
    const h = setup(); h.order.status = ServiceOrderStatus.EN_ROUTE;
    expect(await h.stop()).toMatchObject({ serviceOrderStatus: 'en_route', terminalTransitionApplied: false });
  });

  it.each([
    { commandId: 'not-a-uuid' }, { reason: '  ' }, { reason: 'x'.repeat(2001) },
    { reasonClass: 'non_technician_exception', reasonCode: 'skill_gap' },
    { reasonClass: 'non_technician_exception', reasonCode: 'customer_cancelled' },
    { reasonClass: 'non_technician_exception', reasonCode: 'customer_absent' },
    { photoEvidenceIds: ['not-a-uuid'] }, { photoEvidenceIds: Array.from({ length: 4 }, () => randomUUID()) },
  ])('rejects malformed or wrong-intent input %j', async patch => {
    const h = setup();
    await expect(h.stop({ ...h.command, ...patch })).rejects.toThrow();
    expect(h.rows.AuditLog).toHaveLength(0);
  });

  it('allows optional private photos only from the assigned uploader and order', async () => {
    const h = setup(); const id = randomUUID(); h.command.photoEvidenceIds = [id];
    await expect(h.stop()).rejects.toThrow();
    h.rows.RepairEvidence = [{ id, serviceOrderId: h.order.id, uploaderId: h.tech.id, type: 'additional',
      mimeType: 'image/jpeg', mediaUrl: `cloudinary://evidence/fixhome/evidence/${h.order.id}/${h.tech.id}/${randomUUID()}` }];
    const result = await h.stop();
    expect(JSON.stringify(result)).not.toContain('cloudinary');
    expect(JSON.stringify(result)).not.toContain(id);
  });

  it.each(['foreign_order', 'foreign_uploader', 'public_url', 'face_photo', 'video', 'duplicate'])('rejects %s evidence', async kind => {
    const h = setup(); const id = randomUUID(); h.command.photoEvidenceIds = kind === 'duplicate' ? [id, id.toUpperCase()] : [id];
    h.rows.RepairEvidence = [{ id, serviceOrderId: kind === 'foreign_order' ? randomUUID() : h.order.id,
      uploaderId: kind === 'foreign_uploader' ? randomUUID() : h.tech.id,
      type: kind === 'face_photo' ? 'checkin_face' : 'additional', mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg',
      mediaUrl: kind === 'public_url' ? 'https://example.invalid/photo.jpg' : `cloudinary://evidence/fixhome/evidence/${h.order.id}/${h.tech.id}/${randomUUID()}` }];
    await expect(h.stop()).rejects.toMatchObject({ status: 400 });
    expect(h.rows.SupportCase).toHaveLength(0);
  });

  it('replays the exact command without duplicating case, receipt or notices; rejects a different key or payload', async () => {
    const h = setup(); const first = await h.stop();
    expect(await h.stop({ ...h.command, reason: `  ${h.command.reason}  ` })).toEqual(first);
    await expect(h.stop({ ...h.command, commandId: randomUUID() })).rejects.toThrow();
    await expect(h.stop({ ...h.command, reason: 'Nội dung báo cáo khác nhưng cùng mã lệnh' })).rejects.toThrow();
    expect(h.rows.SupportCase).toHaveLength(1);
    expect(h.rows.AuditLog).toHaveLength(1);
    expect(h.rows.Notification).toHaveLength(3);
  });

  it('normalizes UUID casing and jsonb key order for exact command replay', async () => {
    const h = setup();
    const first = await (h.service as any).cannotContinue(h.order.id.toUpperCase(), {
      ...h.command, commandId: h.command.commandId.toUpperCase(),
    }, h.tech);
    const receipt = h.rows.AuditLog[0];
    const request = receipt.after.request;
    receipt.after.request = { photoEvidenceIds: request.photoEvidenceIds, reason: request.reason,
      reasonCode: request.reasonCode, reasonClass: request.reasonClass, commandId: request.commandId };
    expect(await h.stop()).toEqual(first);
    expect(h.rows.AuditLog).toHaveLength(1);
  });

  it('rejects a future check-in or missing assignment timestamp', async () => {
    const h = setup(); h.checkin.checkedInAt = new Date(Date.now() + 3600000);
    await expect(h.stop()).rejects.toMatchObject({ status: 409 });
    h.rows.ArrivalCheckIn[0].checkedInAt = new Date('2026-10-29T02:00:00Z');
    h.rows.TechnicianAssignment[0].assignedAt = null;
    await expect(h.stop()).rejects.toMatchObject({ status: 409 });
  });

  it('keeps explicit REPORT_ONLY distinct from the cannot-continue command', async () => {
    const h = setup();
    const input = { serviceOrderId: h.order.id, intent: 'REPORT_ONLY', reasonClass: h.command.reasonClass,
      reasonCode: h.command.reasonCode, reason: h.command.reason, evidenceRefs: [] };
    await h.service.report(input as any, h.tech);
    expect(h.rows.AuditLog.map(row => row.action)).toEqual(['TECHNICIAN_EXCEPTION_REPORTED']);
    expect(h.rows.SupportCase[0].holdCompletion).toBe(false);
    expect(await h.eligibility()).toMatchObject({ customerContinuation: { eligible: false } });
    await expect(h.service.report({ ...input, intent: 'CANNOT_CONTINUE_ONSITE' } as any, h.tech))
      .rejects.toMatchObject({ status: 400 });
    expect(h.order.status).toBe('under_repair');
  });

  it('serializes competing commands to one receipt (persistence-double simulation)', async () => {
    const h = setup();
    const results = await Promise.allSettled([h.stop(), h.stop({ ...h.command, commandId: randomUUID() })]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(h.rows.AuditLog).toHaveLength(1);
  });

  it('rejects a reused command for another order', async () => {
    const h = setup(); await h.stop();
    const other = { ...h.order, id: randomUUID(), bookingId: randomUUID() };
    h.rows.ServiceOrder.push(other);
    h.rows.Booking.push({ ...h.booking, id: other.bookingId });
    h.rows.TechnicianAssignment.push({ ...h.assignment, id: randomUUID(), serviceOrderId: other.id });
    h.rows.ArrivalCheckIn.push({ ...h.checkin, id: randomUUID(), serviceOrderId: other.id });
    await expect((h.service as any).cannotContinue(other.id, h.command, h.tech)).rejects.toThrow();
    expect(h.rows.AuditLog).toHaveLength(1);
  });

  it('preserves approved quote, invoices, every money rail, voucher and actual parts without writing any obligation', async () => {
    const h = setup(); h.order.paymentStatus = PaymentStatus.PAID;
    h.rows.Quotation = [{ id: randomUUID(), serviceOrderId: h.order.id, status: 'approved', grandTotal: 500000 }];
    h.rows.Invoice = [{ id: randomUUID(), serviceOrderId: h.order.id, paymentStatus: 'paid', total: 500000 }];
    h.rows.Payment = ['wallet', 'vnpay'].map(provider => ({ id: randomUUID(), invoiceId: h.rows.Invoice[0].id, provider, status: 'verified' }));
    h.rows.CashSettlement = [{ id: randomUUID(), serviceOrderId: h.order.id, status: 'pending' }];
    h.rows.VoucherReservation = [{ id: randomUUID(), scopeId: h.order.id, state: 'RESERVED' }];
    h.rows.PartRequest = [{ id: randomUUID(), serviceOrderId: h.order.id, status: 'received' }];
    h.rows.PartCustody = [{ id: randomUUID(), serviceOrderId: h.order.id,
      state: { issuedQty: 3, usedQty: 1, managerAcceptedQty: 0, outstandingQty: 2 } }];
    const before = structuredClone(h.rows);
    const result = await h.stop();
    for (const entity of Object.keys(before).filter(key => !['AuditLog', 'SupportCase', 'Notification'].includes(key))) {
      expect(h.rows[entity]).toEqual(before[entity]);
    }
    expect(result).toMatchObject({ terminalTransitionApplied: false, oldObligations: { reviewRequired: true,
      quotePreserved: true, moneyPreserved: true, partsPreserved: true, physicalReturnAcceptance: 'MANUAL_SERVICE_MANAGER_ONLY' } });
    expect(h.manager.update).not.toHaveBeenCalled();
    expect(h.rows.PartCustody[0].state.managerAcceptedQty).toBe(0);
  });

  it('keeps group siblings, their outcomes, assignments and one checkout untouched under group lock ordering', async () => {
    const h = setup(); const groupId = randomUUID(); h.booking.visitGroupId = groupId;
    h.rows.VisitGroup = [{ id: groupId, customerId: h.customer.id }];
    h.rows.VisitGroupItem = [{ id: randomUUID(), groupId, bookingId: h.booking.id, sequence: 1, outcome: null },
      { id: randomUUID(), groupId, bookingId: randomUUID(), sequence: 2, outcome: 'succeeded' }];
    h.rows.VisitGroupPayment = [{ id: randomUUID(), visitGroupId: groupId, status: 'verified', amount: 900000 }];
    const before = structuredClone(h.rows);
    await h.stop();
    for (const entity of ['VisitGroup', 'VisitGroupItem', 'VisitGroupPayment', 'TechnicianAssignment']) expect(h.rows[entity]).toEqual(before[entity]);
    const locks = h.operations.filter(op => op.lock).map(op => op.entity);
    expect(locks.slice(0, 4)).toEqual(['Booking', 'VisitGroup', 'Booking', 'ServiceOrder']);
  });

  it('requires exact customer ownership and does not grant source authority from arbitrary case prose', async () => {
    const h = setup();
    expect(await h.eligibility()).toMatchObject({ customerContinuation: { eligible: false } });
    await h.stop();
    await expect(h.eligibility({ id: randomUUID(), role: Role.CUSTOMER })).rejects.toThrow();
    await expect(h.eligibility(h.tech)).rejects.toThrow();
    h.rows.AuditLog[0].after.version = 999;
    expect(await h.eligibility()).toMatchObject({ customerContinuation: { eligible: false } });
    await expect(h.stop()).rejects.toThrow();
  });

  it.each(['duplicate_receipt', 'wrong_case_owner', 'wrong_assignment', 'missing_checkin', 'changed_request', 'missing_request_photos',
    'malformed_assignment_id', 'malformed_evidence_refs'])('fails source proof closed for %s', async kind => {
    const h = setup(); await h.stop();
    if (kind === 'duplicate_receipt') h.rows.AuditLog.push(structuredClone(h.rows.AuditLog[0]));
    if (kind === 'wrong_case_owner') h.rows.SupportCase[0].customerId = randomUUID();
    if (kind === 'wrong_assignment') h.rows.TechnicianAssignment[0].technicianId = randomUUID();
    if (kind === 'missing_checkin') h.rows.ArrivalCheckIn = [];
    if (kind === 'changed_request') h.rows.AuditLog[0].after.request.reason = 'Nội dung receipt đã bị thay đổi';
    if (kind === 'missing_request_photos') delete h.rows.AuditLog[0].after.request.photoEvidenceIds;
    if (kind === 'malformed_assignment_id') h.rows.AuditLog[0].after.assignmentId = 'not-a-uuid';
    if (kind === 'malformed_evidence_refs') h.rows.SupportCase[0].evidenceRefs = {};
    expect(await h.eligibility()).toMatchObject({ customerContinuation: { eligible: false } });
  });

  it('binds the new routes to technician/customer RBAC and validates the HTTP DTO allowlist', async () => {
    expect(Reflect.getMetadata(ROLES_KEY, OnsiteInterruptionController.prototype.cannotContinue)).toEqual([Role.TECHNICIAN]);
    expect(Reflect.getMetadata(ROLES_KEY, OnsiteInterruptionController.prototype.customerContinuation)).toEqual([Role.CUSTOMER]);
    for (const method of [OnsiteInterruptionController.prototype.cannotContinue, OnsiteInterruptionController.prototype.customerContinuation]) {
      expect(Reflect.getMetadata(PERMISSION_KEY, method)).toEqual(['order:read_related']);
    }
    const h = setup(); const validationOptions = { whitelist: true, forbidNonWhitelisted: true };
    expect(await validate(plainToInstance(CannotContinueDto, h.command), validationOptions)).toHaveLength(0);
    expect(await validate(plainToInstance(CannotContinueDto, { ...h.command, grandTotal: 0 }), validationOptions)).not.toHaveLength(0);
    expect(await validate(plainToInstance(CannotContinueDto, { ...h.command, evidenceRefs: ['https://example.invalid'] }), validationOptions)).not.toHaveLength(0);
    expect(await validate(plainToInstance(TechnicianReportDto, { ...h.command, serviceOrderId: h.order.id, intent: 'CANNOT_CONTINUE_ONSITE' }))).not.toHaveLength(0);
  });

  it('keeps receipt authority and completion hold after manager closes or rejects the informational case', async () => {
    const h = setup(); await h.stop();
    h.rows.SupportCase[0].status = SupportCaseStatus.REJECTED;
    h.rows.SupportCase[0].holdCompletion = false;
    expect(await h.eligibility()).toMatchObject({ customerContinuation: { eligible: true } });
    expect(await isCompletionHeld(h.manager, h.order.id)).toBe(true);
    await expect(authorizeOrder(h.manager, h.order.id, h.tech, 'technician', true)).rejects.toThrow();
    await expect(authorizeOrder(h.manager, h.order.id, h.customer, 'customer', true)).rejects.toThrow();
    expect(await authorizeOrder(h.manager, h.order.id, h.tech)).toBe(h.order);
    await expect((h.orders as any).commitTransition(h.manager, h.order, ServiceOrderStatus.COMPLETED,
      { id: null, role: 'system' }, 'late payment')).rejects.toThrow();
    await expect(h.orders.reportRepairFailed(h.order.id, { reason: 'beyond_repair', parts: [] }, h.tech))
      .rejects.toThrow(ConflictException);
    expect(h.rows.AuditLog).toHaveLength(1);
    expect(h.order.status).toBe('under_repair');
  });

  it('prevents a manager reassignment/close from creating a second outcome', async () => {
    const h = setup(); const result = await h.stop();
    const managerActor = { id: randomUUID(), role: Role.SERVICE_MANAGER };
    const options = await h.assignments.replacementOptions(result.incidentId, managerActor);
    expect(options.actions.CLOSE_FOR_REBOOK.allowed).toBe(false);
    expect(options.actions.DIRECT_REASSIGN_SOLO.allowed).toBe(false);
    await expect(h.assignments.resolveInterruption(result.incidentId, { commandId: randomUUID(), expectedCaseVersion: 0,
      action: InterruptionAction.CLOSE_FOR_REBOOK, reason: 'Không tạo thêm kết quả hủy sau receipt onsite' }, managerActor)).rejects.toThrow();
    expect(h.manager.update).not.toHaveBeenCalled();
  });

  it.each(['AuditLog', 'Notification'])('rolls back incident if strict %s persistence fails', async entityName => {
    const h = setup(); const insert = h.manager.insert.getMockImplementation();
    h.manager.insert.mockImplementation(async (entity: any, value: any) => {
      if (entity.name === entityName) throw new Error('simulated storage failure');
      return insert(entity, value);
    });
    await expect(h.stop()).rejects.toThrow('simulated storage failure');
    expect(h.rows.AuditLog).toHaveLength(0);
    expect(h.rows.SupportCase).toHaveLength(0);
    expect(h.rows.Notification).toHaveLength(0);
  });
});
