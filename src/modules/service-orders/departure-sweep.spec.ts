import { describe, expect, it, vi } from 'vitest';
import { ServiceOrdersService } from './service-orders.service';
import { ServiceOrderStatus } from '../../shared/enums';

const minutes = (n: number) => n * 60_000;

function setup(order: { departureWarnedAt: Date | null; status?: ServiceOrderStatus }, windowStart: Date) {
  const state = { order: { id: 'order-1', bookingId: 'booking-1', code: 'FH-1', status: order.status ?? ServiceOrderStatus.ACCEPTED, scheduledAt: windowStart, departureWarnedAt: order.departureWarnedAt } };
  const booking = { id: 'booking-1', customerId: 'customer-1', preferredStartAt: windowStart };
  const assignment = { technicianId: 'tech-1', assignedAt: new Date(windowStart.getTime() - minutes(120)), isActive: true };
  const updates: Array<[string, unknown, Record<string, unknown>]> = [];
  const manager = {
    findOneBy: vi.fn(async (entity: { name: string }) => (entity.name === 'ServiceOrder' ? state.order : entity.name === 'TechnicianAssignment' ? assignment : null)),
    findOne: vi.fn(async (entity: { name: string }) => (entity.name === 'Booking' ? booking : state.order)),
    update: vi.fn(async (entity: { name: string }, where: unknown, values: Record<string, unknown>) => {
      updates.push([entity.name, where, values]);
      if (entity.name === 'ServiceOrder') Object.assign(state.order, values);
      return { affected: 1 };
    }),
    insert: vi.fn(async () => ({})),
    createQueryBuilder: vi.fn(() => {
      const qb = { update: vi.fn(() => qb), set: vi.fn(() => qb), where: vi.fn(() => qb), execute: vi.fn(async () => ({ affected: 0 })) };
      return qb;
    }),
    create: vi.fn((_e: unknown, v: object) => v),
    save: vi.fn(async (_e: unknown, v: object) => v),
  };
  const rows = (ids: string[]) => ({ innerJoin: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), getRawMany: vi.fn(async () => ids.map((id) => ({ id }))) });
  const notifications = { createNotification: vi.fn(async () => ({})) };
  const service = Object.assign(Object.create(ServiceOrdersService.prototype), {
    orderRepo: { createQueryBuilder: vi.fn().mockReturnValueOnce(rows(['order-1'])).mockReturnValueOnce(rows(['order-1'])) },
    dataSource: { transaction: (work: (m: typeof manager) => unknown) => work(manager) },
    configService: { getInt: vi.fn(async (key: string, fallback: number) => (key === 'order.departure_cancel_minutes' ? 10 : fallback)) },
    auditLogService: { logWithManager: vi.fn(async () => undefined) },
    notificationsService: notifications,
  }) as ServiceOrdersService;
  return { service, state, updates, notifications };
}

describe('BRX-063 departure sweep', () => {
  it('warns the technician and the customer once the appointment time has passed', async () => {
    const s = setup({ departureWarnedAt: null }, new Date(Date.now() - minutes(1)));
    await s.service.sweepDepartures();
    expect(s.state.order.departureWarnedAt).toBeInstanceOf(Date);
    expect(s.state.order.status).toBe(ServiceOrderStatus.ACCEPTED);
    const recipients = s.notifications.createNotification.mock.calls.map((call) => (call as unknown as [{ userId: string; type: string }])[0]);
    expect(recipients.map((n) => n.userId).sort()).toEqual(['customer-1', 'tech-1']);
    expect(recipients.every((n) => n.type === 'ORDER_DEPARTURE_WARNING')).toBe(true);
  });

  it('does not warn before the appointment time', async () => {
    const s = setup({ departureWarnedAt: null }, new Date(Date.now() + minutes(30)));
    await s.service.sweepDepartures();
    expect(s.state.order.departureWarnedAt).toBeNull();
    expect(s.notifications.createNotification).not.toHaveBeenCalled();
  });

  it('cancels the order and the booking ten minutes after the warning', async () => {
    const s = setup({ departureWarnedAt: new Date(Date.now() - minutes(11)) }, new Date(Date.now() - minutes(20)));
    await s.service.sweepDepartures();
    expect(s.state.order.status).toBe(ServiceOrderStatus.CANCELLED);
    expect(s.updates.some(([entity, , values]) => entity === 'Booking' && values.status === 'cancelled')).toBe(true);
  });

  it('waits the full ten minutes after the warning', async () => {
    const s = setup({ departureWarnedAt: new Date(Date.now() - minutes(5)) }, new Date(Date.now() - minutes(20)));
    await s.service.sweepDepartures();
    expect(s.state.order.status).toBe(ServiceOrderStatus.ACCEPTED);
  });

  it('leaves a technician who has set out alone', async () => {
    const s = setup({ departureWarnedAt: new Date(Date.now() - minutes(30)), status: ServiceOrderStatus.EN_ROUTE }, new Date(Date.now() - minutes(40)));
    await s.service.sweepDepartures();
    expect(s.state.order.status).toBe(ServiceOrderStatus.EN_ROUTE);
  });
});
