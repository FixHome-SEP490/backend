import { describe, expect, it, vi } from 'vitest';
import { TechnicianAssignmentService } from './technician-assignment.service';
import { Role, ServiceOrderStatus, SupportCaseStatus, SupportCaseType } from '../../shared/enums';
import { InterruptionAction } from './resolve-interruption.dto';

vi.mock('../bookings/technician-eligibility', () => ({ technicianEligibility: vi.fn(async () => ({ eligible: true })) }));
vi.mock('../service-orders/labor-warranty', () => ({ snapshotLaborWarranty: vi.fn(async () => undefined) }));

const actor = { id: 'manager-1', role: Role.SERVICE_MANAGER };
const command = { commandId: '5d1ca553-5f1d-46c0-8c71-1248bcdb855e', expectedCaseVersion: 0,
  action: InterruptionAction.CLOSE_FOR_REBOOK, reason: 'Khách cần kỹ thuật viên khác cho thiết bị này' };

function setup(options: { invoice?: boolean; approvedQuote?: boolean; sentQuote?: boolean; groupPayment?: boolean; assignmentChanged?: boolean; group?: boolean;
  status?: ServiceOrderStatus; technicianCase?: boolean; caseBookingMismatch?: boolean; caseOrderOnly?: boolean; conflictingCase?: boolean } = {}) {
  const booking = { id: 'booking-1', customerId: 'customer-1', visitGroupId: options.group === false ? null : 'group-1', status: 'matched', serviceId: 'service-1' };
  const order = { id: 'order-1', bookingId: booking.id, code: 'FH-1', status: options.status ?? ServiceOrderStatus.UNDER_REPAIR,
    completionRequestedAt: null, paymentStatus: 'unpaid', laborTotal: 100, partsTotal: 0, grandTotal: 100 };
  const supportCase = { id: 'case-1', bookingId: options.caseOrderOnly ? null : options.caseBookingMismatch ? 'booking-other' : booking.id,
    serviceOrderId: order.id, customerId: booking.customerId,
    technicianId: 'tech-1', caseType: options.technicianCase ? SupportCaseType.TECHNICIAN_REPLACEMENT : SupportCaseType.MID_JOB_INTERRUPTION,
    requestIntent: options.technicianCase ? null : 'stop_or_replace',
    status: SupportCaseStatus.OPEN, workflowVersion: 0, interruptionCommandId: null, interruptionFingerprint: null };
  const item = { id: 'item-1', groupId: 'group-1', bookingId: booking.id, outcome: null };
  const assignment = { id: 'assignment-1', technicianId: options.assignmentChanged ? 'tech-3' : 'tech-1', isActive: true };
  const manager = {
    findOne: vi.fn(async (entity: { name: string }) => {
      if (entity.name === 'SupportCase') return supportCase;
      if (entity.name === 'Booking') return booking;
      if (entity.name === 'ServiceOrder') return { ...order };
      if (entity.name === 'VisitGroupItem') return item;
      if (entity.name === 'VisitGroup') return { id: 'group-1' };
      if (entity.name === 'TechnicianAssignment') return assignment;
      if (entity.name === 'Invoice') return options.invoice ? { id: 'invoice-1' } : null;
      if (entity.name === 'VisitGroupPayment') return options.groupPayment ? { id: 'payment-1' } : null;
      if (entity.name === 'User') return { id: 'tech-2' };
      return null;
    }),
    find: vi.fn(async () => []),
    count: vi.fn(async (entity: { name: string }, query: { where?: { status?: unknown } }) => {
      if (entity.name === 'SupportCase') return options.conflictingCase ? 1 : 0;
      if (entity.name !== 'Quotation') return 0;
      if (options.approvedQuote && query.where?.status === 'approved') return 1;
      if (options.sentQuote && query.where?.status !== 'approved') return 1;
      return 0;
    }),
    update: vi.fn(async (entity: { name: string }, _id: unknown, values: Record<string, unknown>) => {
      if (entity.name === 'ServiceOrder') Object.assign(order, values);
      if (entity.name === 'SupportCase') Object.assign(supportCase, values);
      if (entity.name === 'VisitGroupItem') Object.assign(item, values);
      if (entity.name === 'TechnicianAssignment') Object.assign(assignment, values);
      return { affected: 1 };
    }),
    insert: vi.fn(async () => undefined),
    create: vi.fn((_entity: unknown, values: Record<string, unknown>) => values),
    save: vi.fn(async (_entity: unknown, values: Record<string, unknown>) => values),
  };
  const audit = { logWithManagerStrict: vi.fn(async () => undefined) };
  const messaging = { ensureConversation: vi.fn(async () => undefined), attachToServiceOrder: vi.fn(async () => undefined) };
  const service = new TechnicianAssignmentService({} as never, { findOneBy: vi.fn(async () => order) } as never,
    {} as never, {} as never, { transaction: (fn: (m: typeof manager) => unknown) => fn(manager) } as never,
    audit as never, messaging as never);
  Object.assign(service['dataSource'], { manager });
  return { service, manager, audit, messaging, booking, order, supportCase, item, assignment };
}

describe('manager interruption transaction', () => {
  it('closes only the affected group child and replays once', async () => {
    const h = setup();
    const first = await (h.service as any).resolveInterruption('case-1', command, actor);
    const writes = h.manager.update.mock.calls.length;
    const second = await (h.service as any).resolveInterruption('case-1', command, actor);
    expect(second).toEqual(first);
    expect(h.manager.update).toHaveBeenCalledTimes(writes);
    expect(h.order.status).toBe(ServiceOrderStatus.CANCELLED);
    expect(h.item.outcome).toBe('interrupted');
    expect(h.assignment.isActive).toBe(false);
    expect(h.supportCase.status).toBe(SupportCaseStatus.RESOLVED);
    expect(first.nextAction).toBe('interruption_rebook');
    expect(h.audit.logWithManagerStrict).toHaveBeenCalledTimes(1);
  });

  it('blocks invoice exposure before changing order or case', async () => {
    const h = setup({ invoice: true });
    await expect((h.service as any).resolveInterruption('case-1', command, actor)).rejects.toThrow();
    expect(h.manager.update).not.toHaveBeenCalled();
    expect(h.order.status).toBe(ServiceOrderStatus.UNDER_REPAIR);
    expect(h.supportCase.status).toBe(SupportCaseStatus.OPEN);
  });

  it('blocks an approved quote before closing a group child', async () => {
    const h = setup({ approvedQuote: true });
    await expect((h.service as any).resolveInterruption('case-1', command, actor)).rejects.toThrow(/báo giá/);
    expect(h.manager.update).not.toHaveBeenCalled();
  });

  it('blocks a sent quote from being stranded on a closed child', async () => {
    const h = setup({ sentQuote: true });
    await expect((h.service as any).resolveInterruption('case-1', command, actor)).rejects.toThrow(/báo giá/);
    expect(h.manager.update).not.toHaveBeenCalled();
  });

  it('blocks a group payment attempt before closing any child', async () => {
    const h = setup({ groupPayment: true });
    await expect((h.service as any).resolveInterruption('case-1', command, actor)).rejects.toThrow(/thanh toán/);
    expect(h.manager.update).not.toHaveBeenCalled();
  });

  it('blocks a stale case when the active technician has changed', async () => {
    const h = setup({ assignmentChanged: true });
    await expect((h.service as any).resolveInterruption('case-1', command, actor)).rejects.toThrow(/kỹ thuật viên/);
    expect(h.manager.update).not.toHaveBeenCalled();
  });

  it('refuses a case linked to a different booking before touching its order', async () => {
    const h = setup({ caseBookingMismatch: true });
    await expect(h.service.resolveInterruption('case-1', command, actor)).rejects.toThrow();
    expect(h.manager.update).not.toHaveBeenCalled();
  });

  it('rejects a changed replay or stale version without repeating writes', async () => {
    const h = setup();
    await h.service.resolveInterruption('case-1', command, actor);
    const writes = h.manager.update.mock.calls.length;
    await expect(h.service.resolveInterruption('case-1', { ...command, reason: 'Một lý do quản lý khác hoàn toàn' }, actor)).rejects.toThrow();
    await expect(h.service.resolveInterruption('case-1', { ...command, commandId: 'ba4778d0-12b4-46b0-bb48-a1d9be52214a' }, actor)).rejects.toThrow();
    expect(h.manager.update).toHaveBeenCalledTimes(writes);
  });

  it('holds an order when another stop or replacement case is still active', async () => {
    const h = setup({ conflictingCase: true });
    const options = await h.service.replacementOptions('case-1', actor);
    expect(options.actions.CLOSE_FOR_REBOOK.reasons).toContain('CONFLICTING_CASE');
    await expect(h.service.resolveInterruption('case-1', command, actor)).rejects.toThrow();
    expect(h.manager.update).not.toHaveBeenCalled();
  });

  it('rejects the request without changing order or assignment and replays once', async () => {
    const h = setup();
    const reject = { ...command, action: InterruptionAction.REJECT_REQUEST };
    const first = await (h.service as any).resolveInterruption('case-1', reject, actor);
    const writes = h.manager.update.mock.calls.length;
    expect(first.case.status).toBe(SupportCaseStatus.REJECTED);
    expect(first.order.status).toBe(ServiceOrderStatus.UNDER_REPAIR);
    expect(h.assignment.isActive).toBe(true);
    expect(await (h.service as any).resolveInterruption('case-1', reject, actor)).toEqual(first);
    expect(h.manager.update).toHaveBeenCalledTimes(writes);
  });

  it('directly reassigns a solo order only once without a quote or invoice', async () => {
    const h = setup({ group: false });
    const direct = { ...command, action: InterruptionAction.DIRECT_REASSIGN_SOLO, technicianId: 'tech-2' };
    const first = await (h.service as any).resolveInterruption('case-1', direct, actor);
    const writes = h.manager.update.mock.calls.length;
    expect(first.order.status).toBe(ServiceOrderStatus.ACCEPTED);
    expect(h.assignment.isActive).toBe(false);
    expect(h.manager.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ technicianId: 'tech-2', isActive: true }));
    expect(h.messaging.ensureConversation).toHaveBeenCalledOnce();
    expect(await (h.service as any).resolveInterruption('case-1', direct, actor)).toEqual(first);
    expect(h.manager.update).toHaveBeenCalledTimes(writes);
  });

  it('offers and closes a checked-in EN_ROUTE technician case while preserving the group path', async () => {
    const h = setup({ status: ServiceOrderStatus.EN_ROUTE, technicianCase: true });
    const options = await h.service.replacementOptions('case-1', actor);
    expect(options.actions.CLOSE_FOR_REBOOK).toEqual({ allowed: true, reasons: [] });
    expect(options.actions.DIRECT_REASSIGN_SOLO).toMatchObject({ allowed: false, reasons: expect.arrayContaining(['VISIT_GROUP_CHILD']) });
    const result = await h.service.resolveInterruption('case-1', { ...command, expectedCaseVersion: options.caseVersion }, actor);
    expect(result.order.status).toBe(ServiceOrderStatus.CANCELLED);
    expect(h.item.outcome).toBe('interrupted');
    expect(h.manager.insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fromStatus: ServiceOrderStatus.EN_ROUTE }));
  });

  it('offers and directly reassigns a checked-in EN_ROUTE solo technician case', async () => {
    const h = setup({ status: ServiceOrderStatus.EN_ROUTE, technicianCase: true, caseOrderOnly: true, group: false });
    const options = await h.service.replacementOptions('case-1', actor);
    expect(options.actions.DIRECT_REASSIGN_SOLO).toEqual({ allowed: true, reasons: [] });
    const result = await h.service.resolveInterruption('case-1', {
      ...command, expectedCaseVersion: options.caseVersion, action: InterruptionAction.DIRECT_REASSIGN_SOLO, technicianId: 'tech-2',
    }, actor);
    expect(result.order.status).toBe(ServiceOrderStatus.ACCEPTED);
    expect(h.assignment.isActive).toBe(false);
    expect(h.manager.insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fromStatus: ServiceOrderStatus.EN_ROUTE }));
  });
});
