// src/modules/support-cases/support-cases-envelope.spec.ts
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { of } from 'rxjs';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { SupportCasesController } from './support-cases.controller';
import { SupportCaseDetailDto } from './dto';

const detail = {
  id: '33333333-3333-4333-8333-333333333333',
  caseType: 'cash_mismatch',
  status: 'open',
  bookingId: null,
  serviceOrderId: null,
  customerId: 'customer-1',
  technicianId: null,
  createdByUserId: 'customer-1',
  assignedManagerId: null,
  reason: 'The declared cash amount does not match my invoice',
  description: null,
  resolutionCode: null,
  resolutionReason: null,
  evidenceRefs: null,
  resolvedAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  booking: null,
  serviceOrder: null,
  invoice: null,
  cashSettlement: null,
} as unknown as SupportCaseDetailDto;

const makeController = () => {
  const supportCasesService = {
    openCaseForActor: vi.fn().mockResolvedValue({ id: detail.id }),
    findById: vi.fn().mockResolvedValue(detail),
    resolveCase: vi.fn().mockResolvedValue(detail),
    findAll: vi.fn().mockResolvedValue({
      data: [
        {
          id: detail.id,
          caseType: detail.caseType,
          status: detail.status,
          reason: detail.reason,
        },
      ],
      total: 1,
    }),
  };
  const controller = new SupportCasesController(supportCasesService as any);
  return { controller, supportCasesService };
};

describe('Support case single-resource envelope', () => {
  it('returns the inner detail DTO directly for create/detail/resolve', async () => {
    const { controller } = makeController();

    const created = await controller.create({} as any, {
      id: 'customer-1',
      role: 'customer',
    });
    expect(created).toBe(detail);
    expect(created).not.toHaveProperty('data');

    const found = await controller.findOne(detail.id);
    expect(found).toBe(detail);
    expect(found).not.toHaveProperty('data');

    const resolved = await controller.resolve(detail.id, {} as any, {
      id: 'manager-1',
      role: 'service_manager',
    });
    expect(resolved).toBe(detail);
    expect(resolved).not.toHaveProperty('data');
  });

  it('keeps the paginated list shape unchanged', async () => {
    const { controller } = makeController();
    const result = await controller.findAll({ page: 1, limit: 20 } as any);
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('meta');
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.meta).toMatchObject({ page: 1, limit: 20, total: 1 });
  });

  it('lets the global interceptor wrap singles exactly once', async () => {
    const interceptor = new TransformInterceptor();
    const context = {
      switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }),
    } as any;

    const wrapped = (await new Promise((resolve) =>
      interceptor.intercept(context, { handle: () => of(detail) }).subscribe(resolve),
    )) as unknown as Record<string, unknown>;
    expect(wrapped.success).toBe(true);
    expect(wrapped.data).toBe(detail);

    const listed = { data: [{ id: detail.id }], meta: { page: 1, limit: 20, total: 1 } };
    const wrappedList = (await new Promise((resolve) =>
      interceptor.intercept(context, { handle: () => of(listed) }).subscribe(resolve),
    )) as unknown as Record<string, unknown>;
    expect(wrappedList.data).toEqual([{ id: detail.id }]);
    expect(wrappedList.meta).toEqual({ page: 1, limit: 20, total: 1 });
  });

  it('keeps decorator inner schemas aligned with the runtime return', () => {
    const created = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      SupportCasesController.prototype.create,
    );
    const found = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      SupportCasesController.prototype.findOne,
    );
    const resolved = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      SupportCasesController.prototype.resolve,
    );
    expect(created['201']).toMatchObject({ type: SupportCaseDetailDto, isArray: false });
    expect(found['200']).toMatchObject({ type: SupportCaseDetailDto, isArray: false });
    expect(resolved['200']).toMatchObject({ type: SupportCaseDetailDto, isArray: false });
  });
});
