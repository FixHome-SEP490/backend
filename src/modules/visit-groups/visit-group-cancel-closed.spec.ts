import { describe, expect, it, vi } from 'vitest';
import { VisitGroupsService } from './visit-groups.service';
import { BookingStatus } from '../../shared/enums';

// BUG 178: a visit whose technician dropped every device (orders cancelled, bookings closed)
// could not be cancelled: the old check saw "orders exist", handed it to the order rules,
// which found no live order and refused with "Chưa có thợ nhận lượt sửa này."
describe('cancel a visit left without a technician', () => {
  function build(liveOrders: number) {
    const cancelVisit = vi.fn();
    const update = vi.fn().mockResolvedValue(undefined);
    const count = vi.fn().mockResolvedValue(liveOrders);
    const qb = { update: vi.fn(() => qb), set: vi.fn(() => qb), where: vi.fn(() => qb), execute: vi.fn().mockResolvedValue(undefined) };
    const manager = {
      findOne: vi.fn(async (entity: { name: string }) => (entity.name === 'VisitGroup' ? { id: 'g1', customerId: 'c1', status: 'submitted' } : { bookingId: 'b1', id: 'b1' })),
      find: vi.fn().mockResolvedValue([{ id: 'b1', status: BookingStatus.CLOSED }, { id: 'b2', status: BookingStatus.CLOSED }]),
      count,
      update,
      createQueryBuilder: vi.fn(() => qb),
    };
    const dataSource = {
      query: vi.fn().mockResolvedValue([{ n: liveOrders }]),
      transaction: vi.fn(async (fn: (m: typeof manager) => unknown) => fn(manager)),
    };
    const audit = { logWithManager: vi.fn().mockResolvedValue(undefined) };
    const service = new VisitGroupsService(dataSource as never, {} as never, {} as never, {} as never, {} as never, {} as never, audit as never, {} as never, { cancelVisit } as never);
    vi.spyOn(service as unknown as { detail: () => Promise<unknown> }, 'detail').mockResolvedValue({ id: 'g1', status: 'cancelled' });
    return { service, dataSource, cancelVisit, update, count };
  }

  it('only counts orders a technician still holds', async () => {
    const { service, dataSource, cancelVisit, update } = build(0);
    await service.cancel('g1', 'Khách huỷ', { id: 'c1', role: 'customer' });
    expect(dataSource.query.mock.calls[0][0]).toMatch(/o\.status <> 'cancelled'/);
    expect(cancelVisit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.anything(), expect.anything(), { status: BookingStatus.CANCELLED });
    expect(update).toHaveBeenCalledWith(expect.anything(), 'g1', { status: 'cancelled' });
  });

  it('still hands a visit with a live order to the order rules', async () => {
    const { service, cancelVisit } = build(1);
    await service.cancel('g1', 'Khách huỷ', { id: 'c1', role: 'customer' });
    expect(cancelVisit).toHaveBeenCalledWith('g1', { reason: 'Khách huỷ' }, { id: 'c1', role: 'customer' });
  });
});
