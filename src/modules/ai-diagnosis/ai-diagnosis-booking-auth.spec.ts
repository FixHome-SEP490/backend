import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { Booking } from '../bookings/entities/booking.entity';
import { Role } from '../../shared/enums';
import { AiDiagnosisController } from './ai-diagnosis.controller';
import { AiDiagnosisBookingAuthGuard } from './ai-diagnosis-booking-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { ExecutionContext } from '@nestjs/common';
import { AiDiagnosisService } from './ai-diagnosis.service';

const BOOKING_ID = '11111111-1111-1111-1111-111111111111';
const actor = (id = 'owner-1', role: Role = Role.CUSTOMER) => ({ id, role });
function fixture() {
  const manager = {
    findOneBy: vi.fn(async (entity: unknown, where: { id?: string; customerId?: string }) =>
      entity === Booking && where.id === BOOKING_ID && where.customerId === 'owner-1'
        ? { id: BOOKING_ID, customerId: 'owner-1' } : null),
  };
  const diagnosisRepo = { manager, create: vi.fn((x: unknown) => x), save: vi.fn(async (x: unknown) => x) };
  const http = { post: vi.fn(() => of({ data: { status: 'ok', suspectedFaults: [], recommendedServices: [] } })) };
  const serviceRepo = { find: vi.fn(async () => []) };
  const service = new AiDiagnosisService(diagnosisRepo as never, serviceRepo as never,
    http as never, { get: () => 'http://ai.test' } as never);
  const controller = new AiDiagnosisController(service);
  const dto = { description: 'synthetic appliance', bookingId: BOOKING_ID };
  return { service, controller, dto, diagnosisRepo, manager, http };
}

describe('PRIVACY-B POST persisted AI diagnosis', () => {
  it('rejects unauthenticated bookingId before sending images to AI', async () => {
    const f = fixture();
    await expect(f.service.analyze(f.dto)).rejects.toThrow();
    expect(f.http.post).not.toHaveBeenCalled();
    expect(f.diagnosisRepo.save).not.toHaveBeenCalled();
  });
  it('rejects another customer and a technician before any AI request', async () => {
    const f = fixture();
    await expect(f.service.analyze(f.dto, actor('other-customer'))).rejects.toThrow();
    await expect(f.service.analyze(f.dto, actor('technician-1', Role.TECHNICIAN))).rejects.toThrow();
    expect(f.http.post).not.toHaveBeenCalled();
    expect(f.diagnosisRepo.save).not.toHaveBeenCalled();
  });
  it('rejects explicitly null or empty bookingId before invoking AI even through direct service call', async () => {
    const f = fixture();
    for (const invalid of [null, '']) {
      await expect(f.service.analyze({ description: 'synthetic', bookingId: invalid } as never, actor()))
        .rejects.toThrow();
    }
    expect(f.http.post).not.toHaveBeenCalled();
    expect(f.diagnosisRepo.save).not.toHaveBeenCalled();
  });
  it('allows owning customer to persist a diagnosis on their Booking', async () => {
    const f = fixture();
    await f.service.analyze(f.dto, actor());
    expect(f.manager.findOneBy).toHaveBeenCalledWith(Booking, { id: BOOKING_ID, customerId: 'owner-1' });
    expect(f.diagnosisRepo.save).toHaveBeenCalledTimes(1);
  });
  it('preserves anonymous AI requests that do not include bookingId', async () => {
    const f = fixture();
    await expect(f.service.analyze({ description: 'public question' })).resolves.toMatchObject({ aiAvailable: true });
    expect(f.http.post).toHaveBeenCalledTimes(1);
    expect(f.manager.findOneBy).not.toHaveBeenCalled();
    expect(f.diagnosisRepo.save).not.toHaveBeenCalled();
  });
  it('conditional guard leaves anonymous advice open but requires JWT for bookingId', () => {
    const guard = new AiDiagnosisBookingAuthGuard();
    const context = (body: Record<string, unknown>) => ({
      switchToHttp: () => ({ getRequest: () => ({ body }) }),
    }) as unknown as ExecutionContext;
    const parent = vi.spyOn(JwtAuthGuard.prototype, 'canActivate').mockReturnValue(false);
    try {
      expect(guard.canActivate(context({ description: 'public question' }))).toBe(true);
      expect(parent).not.toHaveBeenCalled();
      expect(guard.canActivate(context({ bookingId: BOOKING_ID }))).toBe(false);
      expect(guard.canActivate(context({ bookingId: null }))).toBe(false);
      expect(guard.canActivate(context({ bookingId: '' }))).toBe(false);
      expect(parent).toHaveBeenCalledTimes(3);
    } finally {
      parent.mockRestore();
    }
  });
  it('protects both the new and legacy POST handlers, forwarding actor on both', async () => {
    const f = fixture();
    const controller = f.controller as unknown as { analyze: (dto: typeof f.dto, req: { user?: ReturnType<typeof actor> }) => Promise<unknown>;
      analyzeLegacy: (dto: typeof f.dto, req: { user?: ReturnType<typeof actor> }) => Promise<unknown> };
    await controller.analyze(f.dto, { user: actor() });
    await controller.analyzeLegacy(f.dto, { user: actor() });
    expect(f.diagnosisRepo.save).toHaveBeenCalledTimes(2);
    expect(Reflect.getMetadata('__guards__', AiDiagnosisController.prototype.analyze)).toContain(AiDiagnosisBookingAuthGuard);
    expect(Reflect.getMetadata('__guards__', AiDiagnosisController.prototype.analyzeLegacy)).toContain(AiDiagnosisBookingAuthGuard);
  });
});