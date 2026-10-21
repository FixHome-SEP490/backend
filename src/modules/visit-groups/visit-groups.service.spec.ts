import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { VisitGroupsService } from './visit-groups.service';
import { VisitGroup } from './entities/visit-group.entity';
import { VisitGroupItem } from './entities/visit-group-item.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { refuseLoneGroupedBookingAction } from '../bookings/visit-group-guard';

// PO 21/10/2026: up to three physical devices in one visit, each its own child
// booking (quantity 1), all written in one transaction.
const customer = { id: 'customer-1', role: 'customer' };
const item = (serviceId = 'service-a') => ({ serviceId, deviceLabel: 'Máy lạnh phòng ngủ' });
const start = new Date('2030-10-22T06:00:00Z');
const end = new Date('2030-10-22T11:00:00Z');

function harness(config: Record<string, string> = { 'visit_group.enabled': 'true', 'support.hotline': '1900 0000' }) {
  let created = 0;
  const manager = {
    create: vi.fn((_entity: unknown, data: object) => ({ ...data })),
    save: vi.fn(async (value: object) => ({ id: 'group-1', ...value })),
    insert: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  };
  const dataSource = {
    transaction: vi.fn(async (work: (m: typeof manager) => Promise<unknown>) => work(manager)),
    getRepository: vi.fn(() => ({ find: vi.fn(async () => []), findBy: vi.fn(async () => []) })),
  };
  const groupRepo = { findOneBy: vi.fn(async () => null as unknown), find: vi.fn(async () => []) };
  const itemRepo = { find: vi.fn(async () => []), findOne: vi.fn(async () => ({ bookingId: 'booking-lead' })) };
  const bookingsService = {
    create: vi.fn(async (dto: { serviceId: string }) => {
      created += 1;
      // "Come now" is computed per call: later devices get a slightly later window.
      return { id: `booking-${created}`, serviceId: dto.serviceId, preferredStartAt: new Date(start.getTime() + created), preferredEndAt: end, bookingMode: 'scheduled', slot: 'afternoon' };
    }),
    getCandidates: vi.fn(async () => []),
  };
  const businessConfig = { getString: vi.fn(async (key: string, fallback: string) => config[key] ?? fallback) };
  const supportCases = { openCase: vi.fn(async () => ({ id: 'case-1', status: 'open' })) };
  const audit = { logWithManager: vi.fn(async () => undefined) };
  const invitations = { createShortlist: vi.fn(async () => []), extendPendingInvitationGroup: vi.fn(async () => ({})) };
  const service = new VisitGroupsService(
    dataSource as never, groupRepo as never, itemRepo as never, bookingsService as never,
    businessConfig as never, supportCases as never, audit as never, invitations as never,
  );
  vi.spyOn(service, 'detail').mockImplementation(async (id: string) => ({ id }) as never);
  return { service, manager, dataSource, groupRepo, itemRepo, bookingsService, supportCases, invitations };
}

const dto = (items: Array<{ serviceId: string }>, extra: object = {}) => ({
  addressId: 'address-1', mode: 'scheduled' as const, date: '2030-10-22', slot: 'afternoon' as const, items, ...extra,
});

describe('VisitGroupsService.create', () => {
  it('creates one quantity-1 child booking per device inside the group transaction', async () => {
    const h = harness();
    await h.service.create(dto([item('service-a'), item('service-a')]), customer);

    expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(h.bookingsService.create).toHaveBeenCalledTimes(2);
    for (const [childDto, actor, group] of h.bookingsService.create.mock.calls as unknown as Array<[{ quantity: number; addressId: string }, unknown, { manager: unknown; visitGroupId: string }]>) {
      expect(childDto).toMatchObject({ quantity: 1, addressId: 'address-1', serviceId: 'service-a' });
      expect(actor).toBe(customer);
      expect(group).toEqual({ manager: h.manager, visitGroupId: 'group-1' });
    }
    expect(h.manager.insert.mock.calls.map((call) => (call as unknown as [unknown, { sequence: number; bookingId: string }])[1]))
      .toEqual([expect.objectContaining({ sequence: 1, bookingId: 'booking-1' }), expect.objectContaining({ sequence: 2, bookingId: 'booking-2' })]);
    // Every device takes the first device's window to the millisecond.
    const aligned = h.manager.update.mock.calls.find((call) => (call as unknown as [unknown])[0] === Booking) as unknown as [unknown, unknown, { preferredStartAt: Date }];
    expect(aligned[2].preferredStartAt.getTime()).toBe(start.getTime() + 1);
    const groupWindow = h.manager.update.mock.calls.find((call) => (call as unknown as [unknown])[0] === VisitGroup) as unknown as [unknown, string, { preferredStartAt: Date }];
    expect(groupWindow[2].preferredStartAt.getTime()).toBe(start.getTime() + 1);
  });

  it('refuses a fourth device by stating the limit only, before writing anything', async () => {
    const h = harness();
    await expect(h.service.create(dto([item(), item(), item(), item()]), customer)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VISIT_GROUP_DEVICE_LIMIT', message: 'Mỗi lần đặt được tối đa 3 thiết bị.' }),
    });
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('takes exactly three devices', async () => {
    const h = harness();
    await h.service.create(dto([item('a'), item('b'), item('c')]), customer);
    expect(h.bookingsService.create).toHaveBeenCalledTimes(3);
  });

  it('stays closed while the feature is off', async () => {
    const h = harness({ 'visit_group.enabled': 'false' });
    await expect(h.service.create(dto([item()]), customer)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'FEATURE_DISABLED' }) });
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('returns the first group when the same idempotency key comes again', async () => {
    const h = harness();
    h.groupRepo.findOneBy.mockResolvedValueOnce({ id: 'group-earlier' } as never);
    const result = await h.service.create(dto([item()], { idempotencyKey: 'retry-key-123' }), customer);
    expect(result).toEqual({ id: 'group-earlier' });
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('is for customers only', async () => {
    const h = harness();
    await expect(h.service.create(dto([item()]), { id: 'tech-1', role: 'technician' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reports a null hotline while none is configured', async () => {
    const h = harness({ 'visit_group.enabled': 'true' });
    expect(await h.service.contact()).toEqual({ enabled: true, deviceLimit: 3, hotline: null });
  });

  it('opens a support case for a consultation, without a booking', async () => {
    const h = harness();
    const result = await h.service.requestConsultation({ message: 'Nhà có 5 máy lạnh', devices: ['Máy lạnh 1', ' '] }, customer);
    expect(h.supportCases.openCase).toHaveBeenCalledWith(expect.objectContaining({
      caseType: 'other', customerId: 'customer-1', description: 'Nhà có 5 máy lạnh\nThiết bị: Máy lạnh 1',
    }));
    expect(result).toEqual({ id: 'case-1', status: 'open', hotline: '1900 0000' });
  });
});

describe('VisitGroupsService matching', () => {
  it('lists candidates and shortlists on the lead booking for the whole visit', async () => {
    const h = harness();
    h.groupRepo.findOneBy.mockResolvedValue({ id: 'group-1', status: 'submitted' });
    await h.service.candidates('group-1', customer);
    expect(h.bookingsService.getCandidates).toHaveBeenCalledWith('booking-lead', customer, { asVisit: true });
    await h.service.shortlist('group-1', ['tech-1'], customer);
    expect(h.invitations.createShortlist).toHaveBeenCalledWith('booking-lead', ['tech-1'], customer, { asVisit: true });
    expect(h.itemRepo.findOne).toHaveBeenCalledWith({ where: { groupId: 'group-1' }, order: { sequence: 'ASC' } });
  });

  it('matches nothing for another customer, a cancelled visit or while the feature is off', async () => {
    const h = harness();
    await expect(h.service.candidates('group-1', customer)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'OWNERSHIP_DENIED' }) });
    h.groupRepo.findOneBy.mockResolvedValue({ id: 'group-1', status: 'cancelled' });
    await expect(h.service.shortlist('group-1', ['tech-1'], customer)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ORDER_INVALID_TRANSITION' }) });
    const off = harness({ 'visit_group.enabled': 'false' });
    off.groupRepo.findOneBy.mockResolvedValue({ id: 'group-1', status: 'submitted' });
    await expect(off.service.shortlist('group-1', ['tech-1'], customer)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'FEATURE_DISABLED' }) });
    expect(h.invitations.createShortlist).not.toHaveBeenCalled();
    expect(off.invitations.createShortlist).not.toHaveBeenCalled();
  });
});

describe('a device of a group is never handled alone', () => {
  it('refuses a lone action on a grouped booking and lets a plain one through', () => {
    expect(() => refuseLoneGroupedBookingAction({ visitGroupId: 'group-1' })).toThrow('thao tác này làm trên cả lượt');
    expect(() => refuseLoneGroupedBookingAction({ visitGroupId: null })).not.toThrow();
    expect(VisitGroupItem).toBeDefined();
  });
});
