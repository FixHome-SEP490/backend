import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards';
import { RbacService } from '../rbac/rbac.service';
import { FundedFinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { Role } from '../../shared/enums';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';

let app: INestApplication | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function fixture(role: Role | null = Role.TECHNICIAN, allowed = true) {
  const actor = { id: randomUUID(), role };
  const result = { voucherReservationId: randomUUID(), customerDueVnd: 50000 };
  const lookup = vi.fn(async () => result);
  const permissions = vi.fn(async () => allowed);
  const module = await Test.createTestingModule({
    controllers: [FundedFinanceController],
    providers: [Reflector,
      { provide: FinanceService, useValue: { getVoucherCashReservation: lookup } },
      { provide: RbacService, useValue: { hasPermission: permissions } },
    ],
  }).overrideGuard(JwtAuthGuard).useValue({
    canActivate: (context: any) => {
      // Synthetic test principal; JWT signature verification is outside this HTTP smoke.
      if (!role) (new JwtAuthGuard() as any).handleRequest(null, null, null, context);
      context.switchToHttp().getRequest().user = role ? actor : undefined;
      return true;
    },
  }).compile();
  app = module.createNestApplication();
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.init();
  return { http: app.getHttpServer(), lookup, result, actor, permissions };
}

describe.each([
  ['SOLO', 'solo'], ['VISIT_GROUP', 'visit-groups'],
] as const)('%s funded cash reservation HTTP contract', (scopeKind, path) => {
  it('serves exactly the public DTO through the real role/permission guards', async () => {
    const s = await fixture();
    const id = randomUUID();
    const response = await request(s.http).get(`/finance/funded/${path}/${id}/cash/reservation`).expect(200);
    expect(response.body).toEqual({ success: true, statusCode: 200, message: 'Success', data: s.result });
    expect(s.lookup).toHaveBeenCalledExactlyOnceWith(scopeKind, id, s.actor);
    expect(s.permissions).toHaveBeenCalledWith(Role.TECHNICIAN, 'order:read_related');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('returns an explicit null pair for the nonfunded fallback', async () => {
    const s = await fixture();
    s.lookup.mockResolvedValueOnce({ voucherReservationId: null, customerDueVnd: null } as never);
    const response = await request(s.http).get(`/finance/funded/${path}/${randomUUID()}/cash/reservation`).expect(200);
    expect(response.body.data).toEqual({ voucherReservationId: null, customerDueVnd: null });
  });

  it.each([Role.CUSTOMER, Role.ADMIN, Role.SERVICE_MANAGER])('rejects role %s before lookup', async role => {
    const s = await fixture(role);
    await request(s.http).get(`/finance/funded/${path}/${randomUUID()}/cash/reservation`).expect(403);
    expect(s.lookup).not.toHaveBeenCalled();
  });

  it('rejects permission denial before lookup', async () => {
    const s = await fixture(Role.TECHNICIAN, false);
    await request(s.http).get(`/finance/funded/${path}/${randomUUID()}/cash/reservation`).expect(403);
    expect(s.lookup).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request before lookup', async () => {
    const s = await fixture(null);
    await request(s.http).get(`/finance/funded/${path}/${randomUUID()}/cash/reservation`).expect(401);
    expect(s.lookup).not.toHaveBeenCalled();
  });

  it('validates the UUID before lookup', async () => {
    const s = await fixture();
    await request(s.http).get(`/finance/funded/${path}/not-a-uuid/cash/reservation`).expect(400);
    expect(s.lookup).not.toHaveBeenCalled();
  });
});
