import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Role, ServicePricingMode } from '../../shared/enums';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './booking.dto';
import { PrivateBookingPhotoClaimService } from '../media/private-booking-photo-claim.service';
import { emptySummary, mergeTurn } from '../ai-diagnosis/ai-chat-summary';

// BookingsService.create with synthetic dependencies: the booking takes a frozen
// copy of the customer's own assistant conversation, and only that.
function fixture(session: Record<string, unknown> | null | Error) {
  const actor = { id: 'customer-a', role: Role.CUSTOMER };
  const bookingRepo = {
    create: vi.fn((value: Record<string, unknown>) => value),
    save: vi.fn(async (value: Record<string, unknown>) => ({ id: 'new-booking', ...value })),
  };
  const addressRepo = { findOneBy: vi.fn(async () => ({ id: 'address-1', userId: actor.id,
    line1: 'Synthetic', ward: 'W', district: 'District 1', province: 'Ho Chi Minh City',
    lat: 10.1, lng: 106.1, provinceCode: '79', districtCode: '760' })) };
  const userRepo = { findOneBy: vi.fn(async () => ({ id: actor.id, bookingSuspendedUntil: null })) };
  const serviceRepo = { findOneBy: vi.fn(async () => ({ id: 'service-1', isActive: true, name: 'Sửa điều hòa',
    pricingMode: ServicePricingMode.INSPECTION_REQUIRED })) };
  const sessionRepo = {
    findOneBy: vi.fn(async () => {
      if (session instanceof Error) throw session;
      return session;
    }),
  };
  const manager = { queryRunner: { isTransactionActive: true }, getRepository: vi.fn(() => bookingRepo) };
  const dataSource = {
    query: vi.fn(),
    getRepository: vi.fn(() => sessionRepo),
    transaction: vi.fn(async (callback: (m: typeof manager) => unknown) => callback(manager)),
  };
  const service = new BookingsService(
    bookingRepo as never, {} as never, userRepo as never, serviceRepo as never, addressRepo as never,
    {} as never, {} as never, { log: vi.fn() } as never,
    dataSource as never, new PrivateBookingPhotoClaimService(), {} as never,
  );
  const dto: CreateBookingDto = { serviceId: 'service-1', addressId: 'address-1', description: 'Máy lạnh kêu',
    preferredStartAt: '2030-10-15T03:00:00.000Z', preferredEndAt: '2030-10-15T05:00:00.000Z', aiSessionId: 'sess-1' };
  return { service, actor, dto, bookingRepo, sessionRepo };
}

const advised = mergeTurn(emptySummary(), { text: 'kêu lạch cạch', photoCount: 1 }, {
  status: 'ok', device: { nameVi: 'Máy lạnh' }, suspectedFaults: [{ nameVi: 'Hỏng mô tơ quạt' }],
  priceEstimate: { min: 100000, max: 300000 },
});

describe('Booking keeps a summary of the assistant conversation it came from', () => {
  it('copies the customer\'s own session summary onto the booking', async () => {
    const f = fixture({ sessionId: 'sess-1', customerId: 'customer-a', summary: advised });
    const created = await f.service.create(f.dto, f.actor);
    expect(f.sessionRepo.findOneBy).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    expect(created).toMatchObject({ aiSummary: expect.objectContaining({ deviceName: 'Máy lạnh', suspectedFaults: ['Hỏng mô tơ quạt'], photoCount: 1 }) });
    expect((created as { aiSummary: object }).aiSummary).not.toHaveProperty('turnCount');
  });

  it('accepts an anonymous session (the id is unguessable and came back to this customer)', async () => {
    const f = fixture({ sessionId: 'sess-1', customerId: null, summary: advised });
    expect(await f.service.create(f.dto, f.actor)).toMatchObject({ aiSummary: expect.any(Object) });
  });

  it.each([
    ['another customer\'s session', { sessionId: 'sess-1', customerId: 'customer-b', summary: advised }],
    ['an unknown session', null],
    ['a session that found nothing', { sessionId: 'sess-1', customerId: 'customer-a', summary: emptySummary() }],
  ])('stores no summary for %s', async (_label, session) => {
    const f = fixture(session as Record<string, unknown> | null);
    const created = await f.service.create(f.dto, f.actor);
    expect((created as { aiSummary: unknown }).aiSummary).toBeNull();
  });

  it('still creates the booking when the summary cannot be read', async () => {
    const f = fixture(new Error('db down'));
    const created = await f.service.create(f.dto, f.actor);
    expect(created).toMatchObject({ id: 'new-booking', aiSummary: null });
  });

  it('does not look anything up for a plain booking', async () => {
    const f = fixture(null);
    const { aiSessionId: _omit, ...plain } = f.dto;
    void _omit;
    await f.service.create(plain as CreateBookingDto, f.actor);
    expect(f.sessionRepo.findOneBy).not.toHaveBeenCalled();
  });
});

describe('CreateBookingDto.aiSessionId', () => {
  const base = { serviceId: '11111111-1111-4111-8111-111111111111', addressId: '22222222-2222-4222-8222-222222222222', description: 'x' };
  const errorsFor = async (aiSessionId: unknown) =>
    (await validate(plainToInstance(CreateBookingDto, { ...base, aiSessionId }))).filter((e) => e.property === 'aiSessionId');

  it('accepts the AI service session id shape', async () => {
    expect(await errorsFor('25a67259319c492bb68fd414778b8ce0')).toHaveLength(0);
    expect(await errorsFor('abc_DEF-123')).toHaveLength(0);
  });

  it.each([
    ['empty', ''],
    ['spaces', 'abc def'],
    ['emoji', 'sess😀'],
    ['vietnamese', 'phiên-một'],
    ['sql', "x'; drop table bookings;--"],
    ['too long', 'a'.repeat(129)],
    ['2000 chars', 'a'.repeat(2000)],
    ['number', 12345],
    ['object', { $ne: null }],
  ])('rejects %s', async (_label, value) => {
    expect((await errorsFor(value)).length).toBeGreaterThan(0);
  });
});
