import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { BookingDraftsController } from './booking-drafts.controller';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RiskRateLimitGuard } from '../../common/rate-limit/risk-rate-limit';
import { Role } from '../../shared/enums';

describe('draft transport authorization and write limits', () => {
  it('requires JWT and CUSTOMER RBAC on all four endpoints', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, BookingDraftsController) as Function[];
    expect(guards.map(guard => guard.name)).toEqual(['JwtAuthGuard', 'RolesGuard']);
    const guard = new RolesGuard(new Reflector());
    for (const method of ['current', 'save', 'discard', 'submit'] as const) {
      for (const role of [undefined, Role.TECHNICIAN, Role.SERVICE_MANAGER, Role.ADMIN, Role.CUSTOMER]) {
        const context = { getClass: () => BookingDraftsController, getHandler: () => BookingDraftsController.prototype[method],
          switchToHttp: () => ({ getRequest: () => ({ user: role ? { id: randomUUID(), role } : undefined }) }) } as unknown as ExecutionContext;
        if (role === Role.CUSTOMER) expect(guard.canActivate(context)).toBe(true);
        else expect(() => guard.canActivate(context)).toThrow();
      }
    }
  });

  it('rate-limits manual save/discard separately from real booking submits', () => {
    expect(Reflect.getMetadata('fixhome:risk-limit-bucket', BookingDraftsController.prototype.current)).toBeUndefined();
    for (const name of ['save', 'discard', 'submit'] as const) {
      const handler = BookingDraftsController.prototype[name];
      const expected = name === 'submit' ? 'booking-create' : 'booking-draft-write';
      expect(Reflect.getMetadata('fixhome:risk-limit-bucket', handler)).toBe(expected);
      const user = { id: randomUUID() }; const setHeader = vi.fn();
      const context = { getHandler: () => handler, switchToHttp: () => ({
        getRequest: () => ({ user }), getResponse: () => ({ setHeader }),
      }) } as unknown as ExecutionContext;
      const guard = new RiskRateLimitGuard();
      const limit = name === 'submit' ? 20 : 60;
      for (let i = 0; i < limit; i++) expect(guard.canActivate(context)).toBe(true);
      expect(() => guard.canActivate(context)).toThrow(expect.objectContaining({ status: 429 }));
      expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    }
  });
});
