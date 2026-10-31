import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingStatus, CancelActor, InvitationStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingInvitation } from '../bookings/entities/booking-invitation.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { ServiceOrder } from './entities/service-order.entity';
import { OrderStatusHistory } from './entities/order-status-history.entity';
import { Cancellation } from './entities/cancellation.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { ServiceOrdersService } from './service-orders.service';
import { ServiceOrderStateMachine } from './service-order-state-machine';

const { activateNextInvitationMock } = vi.hoisted(() => ({
  activateNextInvitationMock: vi.fn(),
}));
vi.mock('../bookings/activate-next-invitation', () => ({
  activateNextInvitation: activateNextInvitationMock,
  invitationActivatedHook: () => async () => undefined,
}));

function scenario(hasReplacement: boolean, grouped = false) {
  const groupId = grouped ? 'visit-1' : null;
  const booking = { id: 'booking-1', customerId: 'customer-1', visitGroupId: groupId,
    status: BookingStatus.MATCHED };
  const sibling = { id: 'booking-2', customerId: 'customer-1', visitGroupId: groupId,
    status: BookingStatus.MATCHED };
  const lead = { id: 'order-1', bookingId: booking.id, code: 'FH-1',
    status: ServiceOrderStatus.EN_ROUTE, paymentStatus: 'unpaid', cancelledAt: null as Date | null };
  const second = { id: 'order-2', bookingId: sibling.id, code: 'FH-2',
    status: ServiceOrderStatus.ACCEPTED, paymentStatus: 'unpaid', cancelledAt: null as Date | null };
  const orders = grouped ? [lead, second] : [lead];
  const assignments = new Map(orders.map(order => [order.id, true]));
  const notifications: Array<{ userId: string; title: string; message: string; referenceId: string }> = [];
  const histories: Array<{ serviceOrderId: string; fromStatus: string; toStatus: string; reason: string }> = [];
  const events: string[] = [];
  const manager = {
    findOne: vi.fn(async (entity: unknown, options: { where?: { id?: string } }) => {
      if (entity === ServiceOrder) return orders.find(order => order.id === options.where?.id || order.bookingId === (options.where as { bookingId?: string })?.bookingId) ?? null;
      return null;
    }),
    findOneBy: vi.fn(async (entity: unknown, where: { id?: string; serviceOrderId?: string; technicianId?: string }) => {
      if (entity === Booking) return [booking, sibling].find(b => b.id === where.id) ?? null;
      if (entity === TechnicianAssignment) return assignments.get(where.serviceOrderId ?? '') === true
        && where.technicianId === 'technician-1' ? { technicianId: 'technician-1' } : null;
      return null; // No arrival check-in.
    }),
    find: vi.fn(async (entity: unknown) => {
      if (entity === Booking) return grouped ? [sibling] : [];
      if (entity === BookingInvitation) return hasReplacement ? [
        { priorityOrder: 1, status: InvitationStatus.ACCEPTED, technicianId: 'technician-1' },
        { priorityOrder: 2, status: InvitationStatus.CANCELLED, technicianId: 'technician-2' },
      ] : [{ priorityOrder: 1, status: InvitationStatus.ACCEPTED, technicianId: 'technician-1' }];
      return [];
    }),
    update: vi.fn(async (entity: unknown, where: unknown, update: Record<string, unknown>) => {
      if (entity === Booking) {
        if (where === booking.id) Object.assign(booking, update);
        else for (const b of [booking, sibling]) Object.assign(b, update);
      }
      if (entity === TechnicianAssignment) assignments.set((where as { serviceOrderId: string }).serviceOrderId, false);
      if (entity === ServiceOrder) {
        const found = orders.find(order => order.id === where);
        if (found) Object.assign(found, update);
      }
      return { affected: 1 };
    }),
    create: vi.fn((_entity: unknown, row: object) => row),
    save: vi.fn(async (entity: unknown, row?: unknown) => {
      if (row === undefined) return entity;
      if (entity === Cancellation) return { ...(row as object), id: 'cancel-1' };
      return row;
    }),
    insert: vi.fn(async (entity: unknown, rows: unknown) => {
      if (entity === Notification) {
        events.push('notification');
        notifications.push(...(Array.isArray(rows) ? rows : [rows]) as typeof notifications);
      }
      if (entity === OrderStatusHistory) histories.push(rows as typeof histories[number]);
      return { identifiers: [] };
    }),
    count: vi.fn(async (entity: unknown, options: { where: { serviceOrderId: string } }) =>
      entity === TechnicianAssignment && assignments.get(options.where.serviceOrderId) ? 1 : 0),
  };
  activateNextInvitationMock.mockImplementation(async (_m: unknown, _booking: typeof booking) => {
    events.push('match-decision');
    if (!hasReplacement) {
      await manager.update(Booking, booking.id, { status: BookingStatus.CLOSED });
      if (grouped) await manager.update(Booking, { id: sibling.id }, { status: BookingStatus.CLOSED });
    }
  });
  const createNotification = vi.fn();
  const service = Object.assign(Object.create(ServiceOrdersService.prototype), {
    reputationService: { penalize: vi.fn(async () => undefined) },
    notificationsService: { createNotification },
    auditLogService: { logWithManager: vi.fn(async () => undefined) },
    configService: { getInt: vi.fn(async () => 30) },
  }) as ServiceOrdersService;
  const actor = { id: 'technician-1', role: Role.TECHNICIAN };
  const cancel = (b: typeof booking | typeof sibling, orderId: string, primary?: boolean) =>
    (service as any).cancelLocked(manager, b, orderId, { reason: 'Không thể đến kịp' }, actor,
      primary === undefined ? undefined : { primary });
  return { booking, sibling, lead, second, assignments, notifications, histories, events,
    manager, createNotification, service, cancel };
}

describe('BUG #43/#46 technician withdrawal outcome and notification', () => {
  beforeEach(() => activateNextInvitationMock.mockReset());

  it('no replacement: Booking CLOSED, Order terminal, exactly one committed truthful notice', async () => {
    const s = scenario(false);
    const output = await s.cancel(s.booking, s.lead.id);
    expect(s.booking.status).toBe(BookingStatus.CLOSED);
    expect(s.lead.status).toBe(ServiceOrderStatus.CANCELLED);
    expect(output.status).toBe(ServiceOrderStatus.CANCELLED);
    expect(s.lead.cancelledAt).toBeInstanceOf(Date);
    expect(s.notifications).toHaveLength(1);
    expect(s.notifications[0]).toMatchObject({ userId: 'customer-1', referenceId: 'order-1' });
    expect(s.notifications[0].message).not.toContain('đang tìm');
    expect(s.events).toEqual(['match-decision', 'notification']);
    expect(s.createNotification).not.toHaveBeenCalled();
    expect(s.histories.some(h => h.toStatus === ServiceOrderStatus.CANCELLED)).toBe(true);
  });

  it('replacement available: keeps reusable order, sends one searching notice after decision', async () => {
    const s = scenario(true);
    const output = await s.cancel(s.booking, s.lead.id);
    expect(s.booking.status).toBe(BookingStatus.MATCHING);
    expect(s.lead.status).toBe(ServiceOrderStatus.EN_ROUTE);
    expect(output.status).toBe(ServiceOrderStatus.EN_ROUTE);
    expect(s.notifications).toHaveLength(1);
    expect(s.notifications[0].message).toContain('đang tìm');
    expect(s.events).toEqual(['match-decision', 'notification']);
    expect(s.createNotification).not.toHaveBeenCalled();
  });

  it('VisitGroup without replacement: both child orders terminal but customer gets one notice', async () => {
    const s = scenario(false, true);
    await s.cancel(s.sibling, s.second.id, false);
    expect(s.notifications).toHaveLength(0);
    await s.cancel(s.booking, s.lead.id, true);
    expect(s.booking.status).toBe(BookingStatus.CLOSED);
    expect(s.sibling.status).toBe(BookingStatus.CLOSED);
    expect(s.lead.status).toBe(ServiceOrderStatus.CANCELLED);
    expect(s.second.status).toBe(ServiceOrderStatus.CANCELLED);
    expect(s.notifications).toHaveLength(1);
    expect(s.histories.filter(h => h.toStatus === ServiceOrderStatus.CANCELLED)).toHaveLength(2);
  });

  it('does not manufacture a customer notification if transaction notification insert fails', async () => {
    const s = scenario(false);
    const original = s.manager.insert;
    s.manager.insert = vi.fn(async (entity: unknown, row: unknown) => {
      if (entity === Notification) throw new Error('notification storage unavailable');
      return original(entity, row);
    }) as typeof original;
    await expect(s.cancel(s.booking, s.lead.id)).rejects.toThrow('notification storage unavailable');
    expect(s.notifications).toHaveLength(0);
    expect(s.createNotification).not.toHaveBeenCalled();
  });

  it('never auto-accepts received inventory or changes money during no-replacement closure', async () => {
    const s = scenario(false);
    await s.cancel(s.booking, s.lead.id);
    const partUpdates = s.manager.update.mock.calls.filter(([entity]) =>
      (entity as { name?: string }).name === 'PartRequest');
    expect(partUpdates).toHaveLength(1);
    const partWhere = partUpdates[0][1] as { technicianId: string; status: { value: string[] } };
    expect(partWhere.technicianId).toBe('technician-1');
    expect(partWhere.status.value).not.toContain('received');
    expect(s.manager.update.mock.calls.some(([entity]) =>
      (entity as { name?: string }).name === 'Payment')).toBe(false);
  });

  it('rejects repeat withdrawal after assignment ends, preventing duplicate customer notices', async () => {
    const s = scenario(false);
    await s.cancel(s.booking, s.lead.id);
    await expect(s.cancel(s.booking, s.lead.id)).rejects.toThrow();
    expect(s.notifications).toHaveLength(1);
  });

  it('fails closed if paid evidence unexpectedly exists before a terminal withdrawal', async () => {
    const s = scenario(false);
    s.lead.paymentStatus = 'paid';
    await expect(s.cancel(s.booking, s.lead.id)).rejects.toThrow('quản lý');
    expect(s.notifications).toHaveLength(0);
    expect(s.manager.update.mock.calls.some(([entity]) => entity === ServiceOrder)).toBe(false);
  });

  it('refuses terminal closure when the authoritative state machine denies the transition', async () => {
    const s = scenario(false);
    const transition = vi.spyOn(ServiceOrderStateMachine, 'canTransition').mockReturnValue(false);
    try {
      await expect(s.cancel(s.booking, s.lead.id)).rejects.toThrow();
      expect(s.manager.update.mock.calls.some(([entity]) => entity === ServiceOrder)).toBe(false);
      expect(s.notifications).toHaveLength(0);
    } finally {
      transition.mockRestore();
    }
  });

  it('withdrawal record is still technician-owned without adding fake paid or refund effects', async () => {
    const s = scenario(false);
    await s.cancel(s.booking, s.lead.id);
    expect(s.manager.save).toHaveBeenCalledWith(Cancellation,
      expect.objectContaining({ actor: CancelActor.TECHNICIAN, actorUserId: 'technician-1' }));
    expect(s.manager.update).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ paymentStatus: 'paid' }));
  });
});
