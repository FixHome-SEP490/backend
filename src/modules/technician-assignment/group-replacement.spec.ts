import { describe, expect, it, vi } from 'vitest';
import { TechnicianAssignmentService } from './technician-assignment.service';
import { Role, ServiceOrderStatus } from '../../shared/enums';

function setup(status: ServiceOrderStatus) {
  const booking = { id: 'booking-1', visitGroupId: 'visit-1', status: 'matched' };
  const order = { id: 'order-1', bookingId: booking.id, status };
  const manager = {
    findOne: vi.fn(async (entity: { name: string }) => entity.name === 'Booking' ? booking : order),
    find: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    update: vi.fn(),
    save: vi.fn(),
  };
  const service = new TechnicianAssignmentService(
    {} as never, { findOneBy: vi.fn(async () => order) } as never,
    {} as never, {} as never,
    { transaction: (fn: (m: typeof manager) => unknown) => fn(manager) } as never,
    {} as never, {} as never,
  );
  return { service, manager };
}

describe('one technician per VisitGroup', () => {
  const actor = { id: 'manager-1', role: Role.SERVICE_MANAGER };

  it('rejects legacy child override before any assignment write', async () => {
    const { service, manager } = setup(ServiceOrderStatus.ACCEPTED);
    await expect(service.overrideAssign('technician-new', 'order-1', actor, 'Đổi thợ')).rejects.toThrow('VisitGroup');
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('rejects legacy child replacement before any assignment write', async () => {
    const { service, manager } = setup(ServiceOrderStatus.UNDER_REPAIR);
    await expect(service.replaceAfterReport('order-1', 'technician-new', actor, 'Đổi thợ')).rejects.toThrow('VisitGroup');
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });
});
