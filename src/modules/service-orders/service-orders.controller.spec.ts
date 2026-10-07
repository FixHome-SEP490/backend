import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderListQueryDto } from './dto/order-list-query.dto';
import { ServiceOrderStatus } from '../../shared/enums';
import { ServiceOrdersController } from './service-orders.controller';
import type { ServiceOrdersService } from './service-orders.service';

describe('ServiceOrdersController repair-history query contract', () => {
  it('passes the optional terminal status filter to the service unchanged', async () => {
    const getRepairHistory = vi.fn().mockResolvedValue({ data: [{ orderId: 'order-1' }], total: 1 });
    const controller = new ServiceOrdersController({ getRepairHistory } as unknown as ServiceOrdersService);

    const result = await controller.getRepairHistory(
      { user: { id: 'customer-1', role: 'customer' } },
      plainToInstance(OrderListQueryDto, { page: '2', pageSize: '20', status: ServiceOrderStatus.COMPLETED }),
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
      plainToInstance(OrderListQueryDto, {}),
    );

    expect(getRepairHistory).toHaveBeenCalledWith('customer-1', 'customer', {
      page: 1,
      limit: 20,
      status: undefined,
    });
  });

  it('rejects an unknown status instead of failing in SQL', async () => {
    const errors = await validate(plainToInstance(OrderListQueryDto, { status: 'foo' }));
    expect(errors.map((error) => error.property)).toEqual(['status']);
  });

  it.each([
    [{ page: '-1' }, 'page'],
    [{ pageSize: '-5' }, 'pageSize'],
    [{ pageSize: '100000' }, 'pageSize'],
    [{ page: '99999999999999999999' }, 'page'],
    [{ page: 'abc' }, 'page'],
  ])('rejects bad paging %j', async (query, field) => {
    const errors = await validate(plainToInstance(OrderListQueryDto, query));
    expect(errors.map((error) => error.property)).toEqual([field]);
  });
});
