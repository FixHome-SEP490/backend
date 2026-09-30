import { describe, expect, it, vi } from 'vitest';
import { ServiceOrderStatus } from '../../shared/enums';
import { ServiceOrdersController } from './service-orders.controller';
import type { ServiceOrdersService } from './service-orders.service';

describe('ServiceOrdersController repair-history query contract', () => {
  it('passes the optional terminal status filter to the service unchanged', async () => {
    const getRepairHistory = vi.fn().mockResolvedValue({ data: [{ orderId: 'order-1' }], total: 1 });
    const controller = new ServiceOrdersController({ getRepairHistory } as unknown as ServiceOrdersService);

    const result = await controller.getRepairHistory(
      { user: { id: 'customer-1', role: 'customer' } },
      '2',
      '20',
      ServiceOrderStatus.COMPLETED,
    );

    expect(getRepairHistory).toHaveBeenCalledWith('customer-1', 'customer', {
      page: 2,
      limit: 20,
      status: ServiceOrderStatus.COMPLETED,
    });
    expect(result).toEqual({ data: [{ orderId: 'order-1' }], meta: { total: 1 } });
  });

  it('keeps the legacy no-status request backward compatible', async () => {
    const getRepairHistory = vi.fn().mockResolvedValue({ data: [], total: 0 });
    const controller = new ServiceOrdersController({ getRepairHistory } as unknown as ServiceOrdersService);

    await controller.getRepairHistory(
      { user: { id: 'customer-1', role: 'customer' } },
      undefined,
      undefined,
      undefined,
    );

    expect(getRepairHistory).toHaveBeenCalledWith('customer-1', 'customer', {
      page: 1,
      limit: 20,
      status: undefined,
    });
  });
});
