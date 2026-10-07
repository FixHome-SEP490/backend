import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PageLimitQueryDto } from '../../shared/dto/page-size-query.dto';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { NotificationsController } from './notifications.controller';
import type { NotificationsService } from './notifications.service';
import type { Notification } from './entities/notification.entity';

function createContext(statusCode = 200): ExecutionContext {
  return {
    switchToHttp: () => ({
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

describe('NotificationsController pagination envelope', () => {
  it('returns canonical data + meta and survives the global response interceptor', async () => {
    const rows = [{
      id: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      title: 'Cập nhật đơn',
      message: 'Kỹ thuật viên đang di chuyển.',
      type: 'TECHNICIAN_EN_ROUTE',
      referenceId: '33333333-3333-4333-8333-333333333333',
      referenceType: 'SERVICE_ORDER',
      isRead: false,
      createdAt: new Date('2026-10-01T01:00:00.000Z'),
      updatedAt: new Date('2026-10-01T01:00:00.000Z'),
    }] as unknown as Notification[];

    const getMyNotifications = vi.fn().mockResolvedValue({
      data: rows,
      total: 45,
    });
    const service = { getMyNotifications } as unknown as NotificationsService;
    const controller = new NotificationsController(service);

    const controllerResult = await controller.getMyNotifications(
      { user: { id: 'customer-1' } },
      Object.assign(new PageLimitQueryDto(), { page: 2, limit: 20 }),
    );

    expect(getMyNotifications).toHaveBeenCalledWith('customer-1', 2, 20);
    expect(controllerResult).toEqual({
      data: rows,
      meta: {
        page: 2,
        limit: 20,
        total: 45,
        totalPages: 3,
      },
    });

    const handler: CallHandler = { handle: () => of(controllerResult) };
    const envelope = await new Promise((resolve, reject) => {
      new TransformInterceptor()
        .intercept(createContext(), handler)
        .subscribe({ next: resolve, error: reject });
    });

    expect(envelope).toEqual({
      success: true,
      statusCode: 200,
      message: 'Success',
      data: rows,
      meta: {
        page: 2,
        limit: 20,
        total: 45,
        totalPages: 3,
      },
    });
  });

  it('rejects out-of-range paging before it reaches the query', async () => {
    // page 0 or limit 999 used to be clamped here; the shared query DTO now
    // answers 400, the same contract as every other list.
    const errors = async (query: object) =>
      (await validate(plainToInstance(PageLimitQueryDto, query))).map((error) => error.property);
    expect(await errors({ page: '0', limit: '20' })).toEqual(['page']);
    expect(await errors({ page: '1', limit: '999' })).toEqual(['limit']);
    expect(await errors({ page: '99999999999999999999' })).toEqual(['page']);
    expect(await errors({ page: 'abc' })).toEqual(['page']);
    const defaults = plainToInstance(PageLimitQueryDto, {});
    expect([defaults.page, defaults.limit]).toEqual([1, 20]);
  });
});
