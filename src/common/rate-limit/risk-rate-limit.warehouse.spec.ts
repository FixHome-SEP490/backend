import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RiskRateLimitGuard, consumeRiskRateLimit, RISK_RATE_LIMITS } from './risk-rate-limit';
import { WarehousesController } from '../../modules/warehouses/warehouses.controller';

describe('warehouse stock risk limit', () => {
  it('allows 30 writes per user per minute and rejects the next with HTTP 429', () => {
    expect(RISK_RATE_LIMITS['warehouse-stock']).toEqual({ limit: 30, windowMs: 60_000 });
    const userId = `warehouse-risk-${randomUUID()}`;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(consumeRiskRateLimit('warehouse-stock', `user:${userId}`).allowed).toBe(true);
    }

    let retryAfter: string | undefined;
    const context = {
      getHandler: () => WarehousesController.prototype.adjustStock,
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: userId } }),
        getResponse: () => ({ setHeader: (_name: string, value: string) => { retryAfter = value; } }),
      }),
    } as never;
    let caught: unknown;
    try {
      new RiskRateLimitGuard().canActivate(context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(429);
    expect(retryAfter).toBeDefined();
  });
});
