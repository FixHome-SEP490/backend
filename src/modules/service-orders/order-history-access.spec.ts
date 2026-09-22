import { describe, expect, it, vi } from 'vitest';
import { authorizeOrder } from './order-access';
import { Role, ServiceOrderStatus } from '../../shared/enums';
import { ServiceOrdersService } from './service-orders.service';
import type { EntityManager } from 'typeorm';

const order = { id: 'order-synthetic', bookingId: 'booking-synthetic', code: 'SO-SYNTHETIC',
  status: ServiceOrderStatus.ACCEPTED, createdAt: new Date('2030-01-01T00:00:00Z'),
  scheduledAt: new Date('2030-01-02T00:00:00Z'), addressSummary: 'PRIVATE_ADDRESS',
  customerPhone: 'PRIVATE_PHONE', destination: { lat: 10, lng: 106 },
};
function harness(active: boolean) {
  const manager = {
    findOne: vi.fn(async () => order),
    findOneBy: vi.fn(async (entity: { name: string }, query: Record<string, unknown>) => {
      if (entity.name === 'TechnicianAssignment') return query.technicianId === 'tech-old'
        && (query.isActive === undefined || query.isActive === active) ? { isActive: active, assignedAt: new Date('2030-01-01T01:00:00Z') } : null;
      if (entity.name === 'Booking') return { customerId: 'customer' };
      return null;
    }),
  };
  const repo = { find: vi.fn(async () => []), findOneBy: vi.fn(async () => order),
    createQueryBuilder: vi.fn(() => ({
      innerJoin: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(), take: vi.fn().mockReturnThis(),
      getManyAndCount: vi.fn(async () => [[order], 1]),
    })),
  };
  const presentOrder = vi.fn(async () => ({ ...order, addressSummary: 'PRIVATE_ADDRESS', customerPhone: 'PRIVATE_PHONE' }));
  const service = Object.assign(Object.create(ServiceOrdersService.prototype), {
    orderRepo: repo, dataSource: { manager }, configService: { getInt: vi.fn(async () => 60) },
    presentOrder,
  }) as ServiceOrdersService;
  return { manager, repo, service, presentOrder };
}
describe('historical technician access: safe summary only (synthetic managers)', () => {
  it('rejects inactive technician on generic read access shared by quotations/reviews', async () => {
    const f = harness(false);
    await expect(authorizeOrder(f.manager as unknown as EntityManager, order.id, { id: 'tech-old', role: Role.TECHNICIAN })).rejects.toThrow();
  });
  it('still lets active technician access assigned order', async () => {
    const f = harness(true);
    await expect(authorizeOrder(f.manager as unknown as EntityManager, order.id, { id: 'tech-old', role: Role.TECHNICIAN })).resolves.toMatchObject({ id: order.id });
  });
  it('returns only allowlisted history for old technician on detail and list; no private fields', async () => {
    const f = harness(false);
    const actor = { id: 'tech-old', role: Role.TECHNICIAN };
    const detail = await f.service.findById(order.id, actor);
    const list = await f.service.findMyOrders(actor.id, actor.role, {});
    for (const item of [detail, ...list.data]) {
      expect(item).toMatchObject({ id: order.id, code: order.code, status: order.status, historical: true });
      expect(JSON.stringify(item)).not.toMatch(/PRIVATE_ADDRESS|PRIVATE_PHONE|latitude|longitude|destination|bookingId|customerId|media|diagnosis/i);
    }
    expect(f.presentOrder).not.toHaveBeenCalled();
  });
  it('fails closed when an unexpected role calls my orders', async () => {
    const f = harness(false);
    await expect(f.service.findMyOrders('intruder', 'unexpected', {})).rejects.toThrow();
  });  it('keeps current technician full detail; unrelated actor cannot view old order', async () => {
    const f = harness(true);
    const current = await f.service.findById(order.id, { id: 'tech-old', role: Role.TECHNICIAN });
    expect(current).toMatchObject({ addressSummary: 'PRIVATE_ADDRESS' });
    await expect(f.service.findById(order.id, { id: 'tech-stranger', role: Role.TECHNICIAN })).rejects.toThrow();
  });
});