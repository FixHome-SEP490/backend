import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TechnicianAssignmentService } from './technician-assignment.service';
import { BookingStatus, InvitationStatus, PartRequestStatus, Role, ServiceOrderStatus } from '../../shared/enums';

vi.mock('../bookings/technician-eligibility', () => ({
  technicianEligibility: vi.fn(async () => ({ eligible: true })),
}));

const staff = { id: 'sm-1', role: Role.SERVICE_MANAGER };

function setup(bookingStatus: BookingStatus = BookingStatus.MATCHING) {
  const booking = { id: 'booking-1', customerId: 'customer-1', status: bookingStatus };
  const order = { id: 'order-1', bookingId: 'booking-1', code: 'FH-1', status: ServiceOrderStatus.ACCEPTED };
  const previous = { id: 'assignment-old', serviceOrderId: 'order-1', technicianId: 'tech-old', isActive: true };
  const invitationUpdate = { set: vi.fn(), where: vi.fn(), execute: vi.fn(async () => ({})) };
  invitationUpdate.set.mockReturnValue(invitationUpdate);
  invitationUpdate.where.mockReturnValue(invitationUpdate);
  const manager = {
    findOne: vi.fn(async (entity: { name: string }) => {
      if (entity.name === 'Booking') return booking;
      if (entity.name === 'ServiceOrder') return order;
      if (entity.name === 'TechnicianAssignment') return previous;
      return { id: 'tech-new' };
    }),
    create: vi.fn((_entity: unknown, values: object) => ({ ...values })),
    save: vi.fn(async (value: object) => value),
    update: vi.fn(async () => ({ affected: 1 })),
    createQueryBuilder: vi.fn(() => ({ update: vi.fn(() => invitationUpdate) })),
  };
  const messaging = { ensureConversation: vi.fn(async () => ({})), attachToServiceOrder: vi.fn(async () => undefined) };
  const greeting = { send: vi.fn(async () => undefined) };
  const service = new TechnicianAssignmentService(
    {} as never,
    { findOneBy: vi.fn(async () => order) } as never,
    {} as never,
    {} as never,
    { transaction: (fn: (m: typeof manager) => unknown) => fn(manager) } as never,
    { logWithManager: vi.fn(async () => undefined) } as never,
    messaging as never,
    greeting as never,
  );
  return { service, manager, messaging, greeting, invitationUpdate, previous };
}

describe('Staff replacing the technician of an order', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it('leaves the booking as if the new technician had accepted it', async () => {
    await s.service.overrideAssign('tech-new', 'order-1', staff, 'Thợ cũ báo ốm');

    expect(s.manager.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'Booking' }), 'booking-1', { status: BookingStatus.MATCHED });
    expect(s.invitationUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: InvitationStatus.CANCELLED }));
    expect(s.messaging.ensureConversation).toHaveBeenCalledWith(s.manager, expect.objectContaining({ id: 'booking-1' }), 'tech-new');
    expect(s.messaging.attachToServiceOrder).toHaveBeenCalledWith(s.manager, 'booking-1', 'tech-new', 'order-1');
    expect(s.greeting.send).toHaveBeenCalledWith({ bookingId: 'booking-1', technicianId: 'tech-new', serviceOrderId: 'order-1', orderCode: 'FH-1' });
  });

  it('retires the previous technician and releases their unpicked parts', async () => {
    await s.service.overrideAssign('tech-new', 'order-1', staff, 'Thợ cũ báo ốm');

    expect(s.previous.isActive).toBe(false);
    const partsRelease = (s.manager.update.mock.calls as unknown as unknown[][]).find((call) => (call[0] as { name: string }).name === 'PartRequest') as unknown as [unknown, { technicianId: string }, { status: string }];
    expect(partsRelease[1].technicianId).toBe('tech-old');
    expect(partsRelease[2].status).toBe(PartRequestStatus.CANCELLED);
  });

  it('refuses to assign the technician who already holds the order', async () => {
    await expect(s.service.overrideAssign('tech-old', 'order-1', staff, 'x')).rejects.toThrow('already holds');
    expect(s.greeting.send).not.toHaveBeenCalled();
  });
});
