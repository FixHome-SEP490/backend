import { describe, expect, it, vi } from 'vitest';
import { ServiceOrdersService } from './service-orders.service';
import { User } from '../users/entities/user.entity';
import { ServiceOrder } from './entities/service-order.entity';

// The cancellation and strike review lists are read by Service Managers, who
// may not read user records. The lists therefore carry the name, role and order
// code they show, in two batched lookups rather than one request per row.
const people = [
  { id: 'cust-1', fullName: 'Khách Hàng 1', role: 'customer' },
  { id: 'tech-1', fullName: 'Thợ Điện Lạnh 1', role: 'technician', bookingSuspendedUntil: new Date('2026-10-20T00:00:00Z') },
];
const orders = [
  { id: 'order-1', code: 'FH-20261001-AAAA0001' },
  { id: 'order-2', code: 'FH-20261001-AAAA0002' },
];

function harness(cancellations: Record<string, unknown>[], strikes: Record<string, unknown>[] = []) {
  const userFind = vi.fn(async ({ where }: { where: { id: { _value: string[] } } }) => people.filter((p) => where.id._value.includes(p.id)));
  const orderFind = vi.fn(async ({ where }: { where: { id: { _value: string[] } } }) => orders.filter((o) => where.id._value.includes(o.id)));
  const dataSource = {
    getRepository: vi.fn((entity: unknown) => (entity === User ? { find: userFind } : entity === ServiceOrder ? { find: orderFind } : null)),
  };
  const cancellationRepo = {
    findAndCount: vi.fn(async () => [cancellations, cancellations.length]),
    find: vi.fn(async ({ where }: { where: { id: { _value: string[] } } }) => cancellations.filter((c) => where.id._value.includes(c.id as string))),
  };
  const qb = {
    where: vi.fn(() => qb), orderBy: vi.fn(() => qb), skip: vi.fn(() => qb), take: vi.fn(() => qb),
    getManyAndCount: vi.fn(async () => [strikes, strikes.length]),
  };
  const strikeRepo = { createQueryBuilder: vi.fn(() => qb) };
  const service = Object.assign(Object.create(ServiceOrdersService.prototype), { dataSource, cancellationRepo, strikeRepo }) as ServiceOrdersService;
  return { service, userFind, orderFind };
}

describe('Cancellation review lists for Service Managers', () => {
  it('carries who cancelled and which order, looked up once for the whole page', async () => {
    const h = harness([
      { id: 'c1', serviceOrderId: 'order-1', actorUserId: 'cust-1', reason: 'Đổi ý' },
      { id: 'c2', serviceOrderId: 'order-2', actorUserId: 'tech-1', reason: 'Bận' },
      { id: 'c3', serviceOrderId: 'order-1', actorUserId: 'cust-1', reason: 'Lại đổi ý' },
    ]);
    const { data, total } = await h.service.getCancellations({});
    expect(total).toBe(3);
    expect(data[0]).toMatchObject({ id: 'c1', actorName: 'Khách Hàng 1', actorRole: 'customer', orderCode: 'FH-20261001-AAAA0001' });
    expect(data[1]).toMatchObject({ actorName: 'Thợ Điện Lạnh 1', actorRole: 'technician', orderCode: 'FH-20261001-AAAA0002' });
    expect(h.userFind).toHaveBeenCalledTimes(1);
    expect(h.orderFind).toHaveBeenCalledTimes(1);
  });

  it('leaves names empty, not invented, when a person or order is gone', async () => {
    const h = harness([{ id: 'c1', serviceOrderId: 'order-missing', actorUserId: 'user-missing' }]);
    const { data } = await h.service.getCancellations({});
    expect(data[0]).toMatchObject({ actorName: null, actorRole: null, orderCode: null });
  });

  it('does not query people or orders for an empty page', async () => {
    const h = harness([]);
    expect((await h.service.getCancellations({})).data).toEqual([]);
    expect(h.userFind).not.toHaveBeenCalled();
    expect(h.orderFind).not.toHaveBeenCalled();
  });

  it('carries whose strike it is and the order it came from', async () => {
    const h = harness(
      [{ id: 'c9', serviceOrderId: 'order-2', actorUserId: 'tech-1' }],
      [{ id: 's1', userId: 'tech-1', cancellationId: 'c9', reason: 'Huỷ sát giờ' }],
    );
    const { data } = await h.service.getStrikes({});
    expect(data[0]).toMatchObject({
      id: 's1', userName: 'Thợ Điện Lạnh 1', userRole: 'technician', serviceOrderId: 'order-2', orderCode: 'FH-20261001-AAAA0002',
      userSuspendedUntil: new Date('2026-10-20T00:00:00Z'),
    });
  });
});
