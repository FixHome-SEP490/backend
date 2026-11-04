import { stubPendingVisitQuota } from '../../../test/helpers/pending-visit-quota.fixture';
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ForbiddenException } from '@nestjs/common';
import { VisitGroupsService } from './visit-groups.service';
import { VisitGroupsController } from './visit-groups.controller';
import { CreateVisitGroupDto } from './visit-group.dto';
import { VisitGroup } from './entities/visit-group.entity';
import { VisitGroupItem } from './entities/visit-group-item.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { refuseLoneGroupedBookingAction } from '../bookings/visit-group-guard';

// PO 04/11/2026: up to five physical devices in one visit, each its own child
// booking (quantity 1), all written in one transaction.
const customer = { id: 'customer-1', role: 'customer' };
const item = (serviceId = 'service-a') => ({ serviceId, deviceLabel: 'Máy lạnh phòng ngủ' });
const start = new Date('2030-10-22T06:00:00Z');
const end = new Date('2030-10-22T11:00:00Z');

function harness(config: Record<string, string> = { 'visit_group.enabled': 'true', 'support.hotline': '1900 0000' }) {
  let created = 0;
  const manager = {
    findOneBy: vi.fn(async () => null),
    create: vi.fn((_entity: unknown, data: object) => ({ ...data })),
    save: vi.fn(async (value: object) => ({ id: 'group-1', ...value })),
    insert: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  };
  stubPendingVisitQuota(manager);
  const dataSource = {
    transaction: vi.fn(async (work: (m: typeof manager) => Promise<unknown>) => work(manager)),
    getRepository: vi.fn(() => ({ find: vi.fn(async () => []), findBy: vi.fn(async () => []) })),
    query: vi.fn(async () => [{ n: 0 }]),
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
    getCandidatesWithDiagnostics: vi.fn(async () => ({ candidates: [], emptyReason: 'OUTSIDE_COVERAGE' })),
    reschedule: vi.fn(async () => ({})),
  };
  const businessConfig = { getString: vi.fn(async (key: string, fallback: string) => config[key] ?? fallback) };
  const supportCases = { openCase: vi.fn(async () => ({ id: 'case-1', status: 'open' })) };
  const audit = { logWithManager: vi.fn(async () => undefined) };
  const invitations = { createShortlist: vi.fn(async () => []), extendPendingInvitationGroup: vi.fn(async () => ({})) };
  const serviceOrders = { cancelVisit: vi.fn(async () => [{ id: 'order-1' }, { id: 'order-2' }]) };
  const service = new VisitGroupsService(
    dataSource as never, groupRepo as never, itemRepo as never, bookingsService as never,
    businessConfig as never, supportCases as never, audit as never, invitations as never, serviceOrders as never,
  );
  vi.spyOn(service, 'detail').mockImplementation(async (id: string) => ({ id }) as never);
  return { service, manager, dataSource, groupRepo, itemRepo, bookingsService, supportCases, invitations, serviceOrders };
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

  it('keeps the typed six-device limit error in the service after DTO validation', async () => {
    const addressId = '12345678-1234-4234-8234-123456789012';
    const serviceId = '22345678-1234-4234-8234-123456789012';
    const five = plainToInstance(CreateVisitGroupDto, { addressId, items: Array.from({ length: 5 }, () => ({ serviceId })) });
    const six = plainToInstance(CreateVisitGroupDto, { addressId, items: Array.from({ length: 6 }, () => ({ serviceId })) });
    expect(await validate(five)).toHaveLength(0);
    expect(await validate(six)).toHaveLength(0);
    const h = harness();
    await expect(h.service.create(six, customer)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VISIT_GROUP_DEVICE_LIMIT', message: 'Mỗi lần đặt được tối đa 5 thiết bị.', details: expect.objectContaining({ limit: 5 }) }),
    });
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('takes exactly three devices', async () => {
    const h = harness();
    await h.service.create(dto([item('a'), item('b'), item('c')]), customer);
    expect(h.bookingsService.create).toHaveBeenCalledTimes(3);
  });

  it.each([4, 5])('creates %i devices in one transaction with one sequence per child', async count => {
    const h = harness();
    await h.service.create(dto(Array.from({ length: count }, (_, index) => item(`service-${index + 1}`))), customer);
    expect(h.dataSource.transaction).toHaveBeenCalledOnce();
    expect(h.bookingsService.create).toHaveBeenCalledTimes(count);
    for (const [childDto] of h.bookingsService.create.mock.calls as unknown as Array<[{ addressId: string; mode: string; date: string; slot: string; quantity: number }]>) {
      expect(childDto).toMatchObject({ addressId: 'address-1', mode: 'scheduled', date: '2030-10-22', slot: 'afternoon', quantity: 1 });
    }
    const groupWindow = h.manager.update.mock.calls.find(call => (call as unknown as [unknown])[0] === VisitGroup) as unknown as [unknown, string, { bookingMode: string; slot: string }];
    expect(groupWindow[2]).toMatchObject({ bookingMode: 'scheduled', slot: 'afternoon' });
    expect(h.manager.insert.mock.calls.map(call => (call as unknown as [unknown, { sequence: number }])[1].sequence))
      .toEqual(Array.from({ length: count }, (_, index) => index + 1));
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
    expect(await h.service.contact()).toEqual({ enabled: true, deviceLimit: 5, hotline: null });
  });

  it('routes six-device requests to manual SM consultation without creating a booking', async () => {
    const h = harness();
    const result = await h.service.requestConsultation({ message: 'Nhà có 6 máy lạnh', devices: ['Máy lạnh 1', 'Máy lạnh 2'] }, customer);
    expect(h.supportCases.openCase).toHaveBeenCalledWith(expect.objectContaining({
      caseType: 'other', customerId: 'customer-1', reason: 'Tư vấn đặt từ 6 thiết bị trở lên',
      description: 'Nhà có 6 máy lạnh\nThiết bị: Máy lạnh 1; Máy lạnh 2',
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

  it('explains an empty visit list with the same reason logic as a single booking, on the lead booking', async () => {
    const h = harness();
    h.groupRepo.findOneBy.mockResolvedValue({ id: 'group-1', status: 'submitted' });
    expect(await h.service.candidatesWithDiagnostics('group-1', customer)).toEqual({ candidates: [], emptyReason: 'OUTSIDE_COVERAGE' });
    expect(h.bookingsService.getCandidatesWithDiagnostics).toHaveBeenCalledWith('booking-lead', customer, { asVisit: true });
    // Another customer's visit is refused before any technician is read.
    const other = harness();
    await expect(other.service.candidatesWithDiagnostics('group-1', customer)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'OWNERSHIP_DENIED' }) });
    expect(other.bookingsService.getCandidatesWithDiagnostics).not.toHaveBeenCalled();
    const off = harness({ 'visit_group.enabled': 'false' });
    off.groupRepo.findOneBy.mockResolvedValue({ id: 'group-1', status: 'submitted' });
    await expect(off.service.candidatesWithDiagnostics('group-1', customer)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'FEATURE_DISABLED' }) });
  });

  it('adds meta.emptyReason only when diagnostics=1 is asked, mobile keeps the plain list', async () => {
    const profile = { technicianId: 'profile-1', userId: 'tech-1' };
    const visitGroups = {
      candidates: vi.fn(async () => [profile]),
      candidatesWithDiagnostics: vi.fn(async () => ({ candidates: [profile], emptyReason: null })),
    };
    const controller = Object.assign(Object.create(VisitGroupsController.prototype), { visitGroups }) as VisitGroupsController;
    const request = { user: customer };
    expect(await controller.candidates('group-1', request)).toEqual({ data: [profile] });
    expect(await controller.candidates('group-1', request, 'true')).toEqual({ data: [profile] });
    expect(await controller.candidates('group-1', request, '1')).toEqual({ data: [profile], meta: { emptyReason: null } });
    expect(visitGroups.candidates).toHaveBeenCalledTimes(2);
    expect(visitGroups.candidatesWithDiagnostics).toHaveBeenCalledTimes(1);
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

describe('VisitGroupsService after a technician holds the visit', () => {
  it('moves every device through the lead booking, keeping each description', async () => {
    const h = harness();
    h.groupRepo.findOneBy.mockResolvedValue({ id: 'group-1', status: 'submitted' });
    await h.service.reschedule('group-1', { mode: 'scheduled', date: '2030-10-23', slot: 'morning', description: 'Đổi mô tả' }, customer);
    expect(h.bookingsService.reschedule).toHaveBeenCalledWith('booking-lead', { mode: 'scheduled', date: '2030-10-23', slot: 'morning', description: undefined }, customer, { asVisit: true });
  });

  it('cancels a held visit through the order rules, all orders at once', async () => {
    const h = harness();
    h.dataSource.query.mockResolvedValueOnce([{ n: 2 }]);
    await h.service.cancel('group-1', 'Bận việc', customer);
    expect(h.serviceOrders.cancelVisit).toHaveBeenCalledWith('group-1', { reason: 'Bận việc' }, customer);
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('lets only a technician drop the visit', async () => {
    const h = harness();
    await expect(h.service.withdraw('group-1', 'Xe hỏng', customer)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await h.service.withdraw('group-1', 'Xe hỏng', { id: 'tech-1', role: 'technician' })).toEqual({ visitGroupId: 'group-1', orderIds: ['order-1', 'order-2'] });
  });
});

describe('a device of a group is never handled alone', () => {
  it('refuses a lone action on a grouped booking and lets a plain one through', () => {
    expect(() => refuseLoneGroupedBookingAction({ visitGroupId: 'group-1' })).toThrow('thao tác này làm trên cả lượt');
    expect(() => refuseLoneGroupedBookingAction({ visitGroupId: null })).not.toThrow();
    expect(VisitGroupItem).toBeDefined();
  });
});
