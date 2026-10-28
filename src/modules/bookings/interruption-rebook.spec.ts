import { describe, expect, it, vi } from 'vitest';
import { BookingsService } from './bookings.service';
import { Role, BookingStatus, ServiceOrderStatus, SupportCaseStatus, SupportCaseType } from '../../shared/enums';

function fixture(outcomes = ['succeeded', 'interrupted', 'succeeded']) {
  const bookings = outcomes.map((_, i) => ({ id: `booking-${i}`, customerId: 'customer', serviceId: 'service',
    status: BookingStatus.CANCELLED, visitGroupId: 'group', addressId: 'address',
    description: `Device ${i}`, deviceAttributesSnapshot: { brand: 'TEST' },
    catalogV2PricingSnapshot: { selectedVariant: { variantCode: 'AC-02-01', laborPriceVnd: 999999 } } }));
  const items = outcomes.map((outcome, i) => ({ id: `item-${i}`, groupId: 'group', bookingId: `booking-${i}`, outcome, sequence: i + 1, deviceLabel: `Device ${i}` }));
  const orders = outcomes.map((_, i) => ({ id: `order-${i}`, bookingId: `booking-${i}`, status: ServiceOrderStatus.CANCELLED }));
  const cases = outcomes.map((outcome, i) => ({ id: `case-${i}`, bookingId: `booking-${i}`, serviceOrderId: `order-${i}`,
    customerId: 'customer', technicianId: 'tech-old', caseType: SupportCaseType.MID_JOB_INTERRUPTION,
    status: SupportCaseStatus.RESOLVED, resolutionCode: outcome === 'interrupted' ? 'interrupted_for_rebook' : 'no_action',
    interruptionCommandId: outcome === 'interrupted' ? 'command' : null }));
  const rows: Record<string, any[]> = { Booking: bookings, VisitGroupItem: items, ServiceOrder: orders, SupportCase: cases,
    Address: [{ id: 'address', userId: 'customer', line1: 'Test', province: 'Test province' }],
    Service: [{ id: 'service', isActive: true }], InterruptionRebookSource: [] };
  const manager = {
    findOneBy: vi.fn(async (entity: { name: string }, where: Record<string, unknown>) => (rows[entity.name] ?? []).find(row => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null),
    find: vi.fn(async (entity: { name: string }, options: { where?: Record<string, unknown> }) =>
      (rows[entity.name] ?? []).filter(row => Object.entries(options?.where ?? {}).every(([key, value]) => row[key] === value))),
    insert: vi.fn(), save: vi.fn(), update: vi.fn(),
  };
  const service = Object.assign(Object.create(BookingsService.prototype), { dataSource: { manager } }) as BookingsService;
  return { service, manager, rows, actor: { id: 'customer', role: Role.CUSTOMER } };
}

describe('manager interruption booking draft', () => {
  it('offers only the interrupted child, requires fresh schedule and price, and never copies private photos', async () => {
    const h = fixture();
    const draft = await (h.service as any).interruptionDraft('booking-1', h.actor);
    expect(draft.targetKind).toBe('booking');
    expect(draft.items).toEqual([expect.objectContaining({ sourceBookingId: 'booking-1', sourceCaseId: 'case-1', photos: [] })]);
    expect(draft.items[0]).not.toHaveProperty('fixedUnitPriceSnapshot');
    expect(draft.requiresNewSchedule).toBe(true);
    expect(draft.requiresPricingRevalidation).toBe(true);
    expect(h.manager.save).not.toHaveBeenCalled();
  });

  it('collects two interrupted children into a new visit and rejects unowned or forged sources', async () => {
    const h = fixture(['interrupted', 'interrupted', 'succeeded']);
    const draft = await (h.service as any).interruptionDraft('booking-0', h.actor);
    expect(draft.targetKind).toBe('visit_group');
    expect(draft.items).toHaveLength(2);
    await expect((h.service as any).interruptionDraft('booking-0', { id: 'other', role: Role.CUSTOMER })).rejects.toThrow();
    h.rows.SupportCase[0].interruptionCommandId = null;
    await expect((h.service as any).interruptionDraft('booking-0', h.actor)).rejects.toThrow();
  });

  it('offers a later interrupted sibling after an earlier child was already rebooked', async () => {
    const h = fixture(['interrupted', 'interrupted', 'succeeded']);
    h.rows.InterruptionRebookSource.push({ sourceBookingId: 'booking-0' });
    const draft = await h.service.interruptionDraft('booking-1', h.actor);
    expect(draft.items.map(item => item.sourceBookingId)).toEqual(['booking-1']);
  });
});
