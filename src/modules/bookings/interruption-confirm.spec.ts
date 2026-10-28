import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { BookingsService } from './bookings.service';
import { BookingStatus, Role, ServiceOrderStatus, SupportCaseStatus } from '../../shared/enums';

function setup() {
  const customer = { id: randomUUID(), role: Role.CUSTOMER };
  const sourceBookingId = randomUUID();
  const sourceCaseId = randomUUID();
  const sourceOrderId = randomUUID();
  const addressId = randomUUID();
  const serviceId = randomUUID();
  const targetBookingId = randomUUID();
  const source = { id: sourceBookingId, customerId: customer.id, status: BookingStatus.CANCELLED,
    visitGroupId: null, addressId, serviceId, description: 'Synthetic device', customerNote: null,
    deviceAttributesSnapshot: null, catalogV2PricingSnapshot: null };
  const rows: Record<string, any[]> = {
    Booking: [source], ServiceOrder: [{ id: sourceOrderId, bookingId: sourceBookingId, status: ServiceOrderStatus.CANCELLED }],
    SupportCase: [{ id: sourceCaseId, bookingId: sourceBookingId, serviceOrderId: sourceOrderId,
      customerId: customer.id, technicianId: randomUUID(), status: SupportCaseStatus.RESOLVED,
      resolutionCode: 'interrupted_for_rebook', interruptionCommandId: randomUUID() }],
    Service: [{ id: serviceId, isActive: true }], Address: [{ id: addressId, userId: customer.id, line1: 'Test address' }],
    InterruptionRebook: [], InterruptionRebookSource: [],
  };
  const matches = (row: any, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
  const manager = {
    findOneBy: vi.fn(async (entity: { name: string }, where: Record<string, unknown>) => (rows[entity.name] ?? []).find(row => matches(row, where)) ?? null),
    findOne: vi.fn(async (entity: { name: string }, options: { where: Record<string, unknown> }) => (rows[entity.name] ?? []).find(row => matches(row, options.where)) ?? null),
    find: vi.fn(async (entity: { name: string }, options: { where: Record<string, unknown> }) => (rows[entity.name] ?? []).filter(row => matches(row, options.where))),
    create: vi.fn((_entity: unknown, value: Record<string, unknown>) => value),
    save: vi.fn(async (entity: { name: string }, value: Record<string, unknown>) => {
      const saved = { id: randomUUID(), ...value }; rows[entity.name].push(saved); return saved;
    }),
    insert: vi.fn(async (entity: { name: string }, value: Record<string, unknown>) => { rows[entity.name].push({ id: randomUUID(), ...value }); }),
  };
  const create = vi.fn(async () => ({ id: targetBookingId }));
  const service = Object.assign(Object.create(BookingsService.prototype), {
    dataSource: { manager, transaction: (fn: (m: typeof manager) => unknown) => fn(manager) }, create,
  }) as BookingsService;
  const dto = { idempotencyKey: 'confirmed-001', addressId, date: '2030-10-28', slot: 'afternoon' as const,
    items: [{ sourceBookingId, sourceCaseId }] };
  return { service, customer, sourceBookingId, sourceCaseId, targetBookingId, dto, manager, create, rows };
}

describe('confirmed interruption rebook', () => {
  it('links one new repriced booking and returns identical receipt on retry', async () => {
    const h = setup();
    const first = await h.service.confirmInterruptionRebook(h.sourceBookingId, h.dto, h.customer, vi.fn() as never);
    const second = await h.service.confirmInterruptionRebook(h.sourceBookingId, h.dto, h.customer, vi.fn() as never);
    expect(second).toEqual(first);
    expect(first.bookingId).toBe(h.targetBookingId);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.rows.InterruptionRebook).toHaveLength(1);
    expect(h.rows.InterruptionRebookSource).toHaveLength(1);
  });

  it('rejects changed command payload and a second key for an already consumed source', async () => {
    const h = setup();
    await h.service.confirmInterruptionRebook(h.sourceBookingId, h.dto, h.customer, vi.fn() as never);
    await expect(h.service.confirmInterruptionRebook(h.sourceBookingId, { ...h.dto, date: '2030-10-29' }, h.customer, vi.fn() as never)).rejects.toThrow();
    await expect(h.service.confirmInterruptionRebook(h.sourceBookingId, { ...h.dto, idempotencyKey: 'confirmed-002' }, h.customer, vi.fn() as never)).rejects.toThrow();
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('rebooks two interrupted group children together without losing either source link', async () => {
    const h = setup();
    const groupId = randomUUID();
    const secondBookingId = randomUUID();
    const secondCaseId = randomUUID();
    const secondOrderId = randomUUID();
    const secondTargetId = randomUUID();
    h.rows.Booking[0].visitGroupId = groupId;
    h.rows.Booking.push({ ...h.rows.Booking[0], id: secondBookingId, description: 'Second device' });
    h.rows.ServiceOrder.push({ id: secondOrderId, bookingId: secondBookingId, status: ServiceOrderStatus.CANCELLED });
    h.rows.SupportCase.push({ ...h.rows.SupportCase[0], id: secondCaseId, bookingId: secondBookingId,
      serviceOrderId: secondOrderId, interruptionCommandId: randomUUID() });
    h.rows.VisitGroupItem = [
      { groupId, bookingId: h.sourceBookingId, sequence: 1, outcome: 'interrupted', deviceLabel: 'A' },
      { groupId, bookingId: secondBookingId, sequence: 2, outcome: 'interrupted', deviceLabel: 'B' },
    ];
    const groupCreate = vi.fn(async () => ({ id: randomUUID(), items: [
      { booking: { id: h.targetBookingId } }, { booking: { id: secondTargetId } },
    ] }));
    const dto = { ...h.dto, items: [...h.dto.items, { sourceBookingId: secondBookingId, sourceCaseId: secondCaseId }] };
    const result = await h.service.confirmInterruptionRebook(h.sourceBookingId, dto, h.customer, groupCreate);
    expect(result.targetKind).toBe('visit_group');
    expect(result.items).toEqual(expect.arrayContaining([
      { sourceBookingId: h.sourceBookingId, sourceCaseId: h.sourceCaseId, bookingId: h.targetBookingId },
      { sourceBookingId: secondBookingId, sourceCaseId: secondCaseId, bookingId: secondTargetId },
    ]));
    expect(h.create).not.toHaveBeenCalled();
    expect(groupCreate).toHaveBeenCalledOnce();
    expect(h.rows.InterruptionRebookSource).toHaveLength(2);
  });
});
