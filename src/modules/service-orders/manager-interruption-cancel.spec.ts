import { describe, expect, it, vi } from 'vitest';
import { ServiceOrdersService } from './service-orders.service';
import { Role, ServiceOrderStatus } from '../../shared/enums';

describe('legacy manager cancellation during repair', () => {
  it('requires the atomic support case command before touching the order', async () => {
    const order = { id: 'order-1', bookingId: 'booking-1', status: ServiceOrderStatus.UNDER_REPAIR };
    const manager = {
      findOne: vi.fn(async () => order),
      findOneBy: vi.fn(async () => null),
      update: vi.fn(), save: vi.fn(), insert: vi.fn(),
    };
    const service = Object.create(ServiceOrdersService.prototype) as ServiceOrdersService;
    await expect((service as any).cancelLocked(manager, { id: 'booking-1' }, order.id,
      { reason: 'Khách cần thợ khác' }, { id: 'manager-1', role: Role.SERVICE_MANAGER })).rejects.toThrow('resolve-interruption');
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });
});
