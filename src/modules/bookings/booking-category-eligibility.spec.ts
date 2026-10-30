import { describe, expect, it, vi } from 'vitest';
import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';
import { BookingStatus, Role, ServicePricingMode } from '../../shared/enums';

function fixture(code = 'QA_LEGACY') {
  const service = { id: 'service', code, name: 'Synthetic service', isActive: true,
    pricingMode: ServicePricingMode.FIXED_PRICE, fixedPrice: 199000 };
  let categoryActive: boolean | null = true;
  const saved: unknown[] = [];
  const repository = { create: (value: object) => value,
    save: vi.fn(async (value: object) => { saved.push(value); return { id: 'new-booking', ...value }; }) };
  const manager = {
    query: vi.fn(async (sql: string) => sql.includes('JOIN service_categories')
      ? service.isActive && categoryActive === true ? [{ code }] : [] : []),
    findOneBy: async () => null, find: async () => [],
    getRepository: (entity: unknown) => entity === Booking ? repository : {},
  };
  const bookings = Object.assign(Object.create(BookingsService.prototype), {
    bookingRepo: { findOneBy: async () => ({ id: 'old', customerId: 'customer', status: BookingStatus.CANCELLED,
      serviceId: service.id, addressId: 'address', quantity: 1, description: 'Synthetic repair' }) },
    userRepo: { findOneBy: async () => ({ id: 'customer' }) },
    serviceRepo: { findOneBy: async () => service },
    addressRepo: { findOneBy: async () => ({ userId: 'customer', line1: 'Synthetic', lat: 10.77, lng: 106.7 }) },
    dataSource: { manager, transaction: async (fn: (m: typeof manager) => unknown) => fn(manager) },
    auditLogService: { log: async () => {}, logWithManager: async () => {} },
  }) as BookingsService;
  const customer = { id: 'customer', role: Role.CUSTOMER };
  const dto = { serviceId: service.id, addressId: 'address', description: 'Synthetic repair',
    mode: 'scheduled' as const, date: '2030-10-15', slot: 'morning' as const };
  return { bookings, customer, dto, manager, saved, service, setCategory: (value: boolean | null) => { categoryActive = value; } };
}

describe('#32 authoritative category booking gate', () => {
  it.each(['QA_LEGACY', 'AC-02'])('permits active service and active category for %s', async code => {
    const f = fixture(code);
    expect(await f.bookings.create(f.dto, f.customer)).toMatchObject({ id: 'new-booking' });
    expect(f.saved).toHaveLength(1);
  });

  it.each(['create', 'rebook', 'group', 'interruption-child'] as const)(
    'rejects disabled/missing category at %s without saving a booking', async path => {
      for (const active of [false, null]) {
        const f = fixture();
        f.setCategory(active);
        const pending = path === 'rebook' ? f.bookings.rebook('old', f.customer, f.dto)
          : path === 'create' ? f.bookings.create(f.dto, f.customer)
            : f.bookings.create(f.dto, f.customer, { manager: f.manager as never,
              visitGroupId: path === 'group' ? 'visit' : null });
        await expect(pending).rejects.toMatchObject({ status: 404 });
        expect(f.saved).toEqual([]);
      }
    });

  it('rejects a service paused after the first lookup at the transactional boundary', async () => {
    const f = fixture();
    const original = f.manager.query.getMockImplementation()!;
    f.manager.query.mockImplementation(async sql => { f.service.isActive = false; return original(sql); });
    await expect(f.bookings.create(f.dto, f.customer)).rejects.toMatchObject({ status: 404 });
    expect(f.saved).toEqual([]);
  });
});
