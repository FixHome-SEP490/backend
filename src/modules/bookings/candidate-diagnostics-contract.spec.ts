import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';

function fakeService(latitudeSnapshot: number | null, owned = true) {
  const booking = {
    id: 'booking-1', customerId: 'customer-1', serviceId: 'service-1',
    latitudeSnapshot, longitudeSnapshot: latitudeSnapshot == null ? null : 106.7,
    bookingMode: 'scheduled', visitGroupId: null,
  };
  const builder = {
    innerJoinAndSelect: vi.fn(),
    where: vi.fn(), andWhere: vi.fn(),
    getMany: vi.fn(async () => []),
  };
  builder.innerJoinAndSelect.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.andWhere.mockReturnValue(builder);
  const bookingFind = vi.fn(async (query: { where: { customerId?: string } }) =>
    owned && (!query.where.customerId || query.where.customerId === booking.customerId) ? booking : null);
  const service = Object.assign(Object.create(BookingsService.prototype), {
    bookingRepo: { findOne: bookingFind },
    techProfileRepo: { createQueryBuilder: vi.fn(() => builder) },
    configService: { getInt: vi.fn(async () => 15) },
    addressRepo: { find: vi.fn() },
    dataSource: { manager: { find: vi.fn() } },
  }) as BookingsService;
  return { service, bookingFind };
}

describe('BUG #41 — Booking candidates original API contract and diagnostics', () => {
  const customer = { id: 'customer-1', role: 'customer' };

  it('keeps native/mobile array results unchanged, with opt-in empty reason for Web', async () => {
    const { service } = fakeService(null);
    expect(await service.getCandidates('booking-1', customer)).toEqual([]);
    expect(await service.getCandidatesWithDiagnostics('booking-1', customer)).toEqual({
      candidates: [], emptyReason: 'BOOKING_LOCATION_MISSING',
    });
  });

  it('does not invent coverage from an empty pool of verified/available technicians', async () => {
    const { service } = fakeService(10.77);
    expect(await service.getCandidatesWithDiagnostics('booking-1', customer)).toEqual({
      candidates: [], emptyReason: 'UNAVAILABLE',
    });
  });

  it('refuses unauthorised access before inspecting any technicians', async () => {
    const { service, bookingFind } = fakeService(10.77, false);
    await expect(service.getCandidatesWithDiagnostics('booking-1', { id: 'stranger', role: 'customer' }))
      .rejects.toThrow('Booking not found');
    expect(bookingFind).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'booking-1', customerId: 'stranger' },
    }));
  });

  it('only returns extra fields when the explicitly opted-in query parameter is 1', async () => {
    const profile = { id: 'profile-1', userId: 'tech-1' };
    const search = {
      getCandidates: vi.fn(async () => [profile]),
      getCandidatesWithDiagnostics: vi.fn(async () => ({
        candidates: [profile], emptyReason: null,
      })),
    };
    const controller = Object.assign(Object.create(BookingsController.prototype), {
      bookingsService: search,
    }) as BookingsController;
    const request = { user: customer };
    expect(await controller.getCandidates('booking-1', request)).toEqual({ data: [profile] });
    expect(await controller.getCandidates('booking-1', request, '1')).toEqual({
      data: [profile], emptyReason: null,
    });
    expect(search.getCandidates).toHaveBeenCalledTimes(1);
    expect(search.getCandidatesWithDiagnostics).toHaveBeenCalledTimes(1);
  });
});
