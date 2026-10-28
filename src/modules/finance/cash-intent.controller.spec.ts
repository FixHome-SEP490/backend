import { describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of } from 'rxjs';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { CashIntentController } from './cash-intent.controller';

describe('cash intent HTTP response', () => {
  it('does not expose receipt evidence or internal allocation rows on GET', async () => {
    const finance = { isCashFirstEnabled: vi.fn(() => false), getCashIntent: vi.fn(async () => ({
      id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', status: 'pending',
      customerDueVnd: 120_000, grossVnd: 150_000, technicianId: 'tech-1',
      receiptEvidenceUrl: 'private-reference', allocations: [{ invoiceId: 'invoice-1' }],
    })) };
    const controller = new CashIntentController(finance as any);
    const response = await controller.get('SOLO' as any, 'order-1', { user: { id: 'customer-1', role: 'customer' } });
    expect(response.meta.cashFirstEnabled).toBe(false);
    expect(response.data).toMatchObject({ id: 'intent-1', status: 'pending', customerDueVnd: 120_000 });
    expect(response.data).not.toHaveProperty('receiptEvidenceUrl');
    expect(response.data).not.toHaveProperty('allocations');
  });

  it('returns capability only after ownership-checked read succeeds', async () => {
    const finance = {
      getCashIntent: vi.fn().mockResolvedValue(null),
      isCashFirstEnabled: vi.fn().mockReturnValue(true),
    };
    const controller = new CashIntentController(finance as any);
    await expect(controller.get('SOLO' as any, 'order-1', { user: { id: 'customer-1', role: 'customer' } }))
      .resolves.toEqual({ data: null, meta: { cashFirstEnabled: true } });
    const wire = await firstValueFrom(new TransformInterceptor().intercept(
      { switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }) } as any,
      { handle: () => of({ data: null, meta: { cashFirstEnabled: true } }) } as any,
    ));
    expect(wire).toMatchObject({ data: null, meta: { cashFirstEnabled: true } });
    finance.getCashIntent.mockRejectedValueOnce(new Error('ownership denied'));
    await expect(controller.get('SOLO' as any, 'private-order', { user: { id: 'other', role: 'customer' } }))
      .rejects.toThrow('ownership denied');
    expect(finance.isCashFirstEnabled).toHaveBeenCalledTimes(1);
  });
});
