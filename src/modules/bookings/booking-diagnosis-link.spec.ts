import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Role, ServicePricingMode } from '../../shared/enums';
import { BookingsService } from './bookings.service';
import type { CreateBookingDto } from './booking.dto';
import { PrivateBookingPhotoClaimService } from '../media/private-booking-photo-claim.service';

// Actual BookingsService.create with synthetic dependencies: no database or personal data.
function fixture() {
  const actor = { id: 'synthetic-customer-a', role: Role.CUSTOMER };
  const previousDiagnosis = { id: 'diagnosis-1', bookingId: 'existing-booking-a', ownerId: 'synthetic-customer-a' };
  const bookingRepo = {
    create: vi.fn((value: Record<string, unknown>) => value),
    save: vi.fn(async (value: Record<string, unknown>) => ({ id: 'new-booking-a', ...value })),
  };
  const query = vi.fn(async (_sql: string, params: unknown[]) => {
    // Simulate the owner-constrained UPDATE: foreign diagnoses cannot be relinked.
    if (params.length === 3 && params[2] === previousDiagnosis.ownerId && params[1] === previousDiagnosis.id) {
      previousDiagnosis.bookingId = String(params[0]);
      return [{ id: previousDiagnosis.id }];
    }
    if (params.length === 2 && params[1] === previousDiagnosis.id) {
      previousDiagnosis.bookingId = String(params[0]); // Old vulnerable SQL had no owner guard.
      return [{ id: previousDiagnosis.id }];
    }
    return [];
  });
  const addressRepo = { findOneBy: vi.fn(async () => ({ id: 'address-1', userId: actor.id,
    line1: 'Synthetic address', ward: 'Ward', district: 'District 1', province: 'Ho Chi Minh City',
    lat: 10.12345, lng: 106.12345, provinceCode: '79', districtCode: '760' })) };
  const userRepo = { findOneBy: vi.fn(async () => ({ id: actor.id, bookingSuspendedUntil: null })) };
  const serviceRepo = { findOneBy: vi.fn(async () => ({ id: 'service-1', isActive: true, name: 'Repair',
    pricingMode: ServicePricingMode.INSPECTION_REQUIRED, description: 'Repair service' })) };
  const audit = { log: vi.fn(async () => undefined) };
  const manager = {
    queryRunner: { isTransactionActive: true },
    getRepository: vi.fn(() => bookingRepo),
  };
  const dataSource = {
    query,
    transaction: vi.fn(async (callback: (transactionManager: typeof manager) => unknown) => callback(manager)),
  };
  const service = new BookingsService(
    bookingRepo as never, {} as never, userRepo as never, serviceRepo as never, addressRepo as never,
    {} as never, {} as never, {} as never, audit as never,
    dataSource as never, new PrivateBookingPhotoClaimService(), {} as never,
  );
  const dto: CreateBookingDto = { serviceId: 'service-1', addressId: 'address-1',
    description: 'Synthetic repair', preferredStartAt: '2030-10-15T03:00:00.000Z',
    preferredEndAt: '2030-10-15T05:00:00.000Z', aiDiagnosisId: previousDiagnosis.id };
  return { service, actor, query, dto, previousDiagnosis };
}

describe('PRIVACY-B: a customer cannot steal another booking diagnosis during Booking creation', () => {
  it('atomically constrains diagnosis re-link by the original booking customer id', async () => {
    const f = fixture();
    f.previousDiagnosis.ownerId = 'synthetic-customer-b';
    await f.service.create(f.dto, f.actor);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.query).toHaveBeenCalledWith(
      expect.stringContaining('source."customer_id" = $3'),
      ['new-booking-a', f.dto.aiDiagnosisId, f.actor.id],
    );
    expect(f.previousDiagnosis.bookingId).toBe('existing-booking-a');
  });
  it('preserves the same-customer association when the source booking is owned by the actor', async () => {
    const f = fixture();
    await f.service.create(f.dto, f.actor);
    expect(f.previousDiagnosis.bookingId).toBe('new-booking-a');
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('diagnosis."booking_id" = source."id"'),
      ['new-booking-a', f.dto.aiDiagnosisId, f.actor.id]);
  });
});
