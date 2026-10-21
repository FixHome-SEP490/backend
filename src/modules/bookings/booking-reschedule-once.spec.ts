import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BookingStatus } from '../../shared/enums';
import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';

// PO 21/10/2026: the arrival session of a booking moves at most once; the
// description stays editable.
function harness(rescheduleCount: number) {
  const start = new Date(Date.now() + 2 * 86_400_000);
  const end = new Date(start.getTime() + 4 * 3_600_000);
  const booking = {
    id: 'booking-move-once', customerId: 'synthetic-owner', status: BookingStatus.MATCHING,
    description: 'Old description', preferredStartAt: start, preferredEndAt: end, rescheduleCount,
  };
  const queryBuilder = {
    update: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(), execute: vi.fn(async () => ({ affected: 0 })),
  };
  const manager = {
    findOne: vi.fn(async (entity: unknown) => entity === Booking ? booking : null),
    createQueryBuilder: vi.fn(() => queryBuilder),
    save: vi.fn(async (value: unknown) => value),
  };
  const audit = { logWithManager: vi.fn(async () => undefined) };
  const dataSource = { transaction: vi.fn(async (fn: (m: typeof manager) => Promise<unknown>) => fn(manager)) };
  const service = Object.create(BookingsService.prototype) as BookingsService;
  Object.assign(service, { dataSource, auditLogService: audit });
  const moved = new Date(start.getTime() + 3_600_000);
  const moveDto = { preferredStartAt: moved.toISOString(), preferredEndAt: new Date(moved.getTime() + 4 * 3_600_000).toISOString() };
  const sameDto = { preferredStartAt: start.toISOString(), preferredEndAt: end.toISOString(), description: 'New words' };
  return { booking, manager, audit, service, moveDto, sameDto };
}

describe('one reschedule per booking', () => {
  it('counts the first move', async () => {
    const f = harness(0);
    const result = await f.service.reschedule(f.booking.id, f.moveDto, { id: f.booking.customerId });
    expect(result.rescheduleCount).toBe(1);
    expect(f.manager.save).toHaveBeenCalledTimes(1);
  });

  it('refuses a second move in Vietnamese and changes nothing', async () => {
    const f = harness(1);
    const before = f.booking.preferredStartAt;
    await expect(f.service.reschedule(f.booking.id, f.moveDto, { id: f.booking.customerId }))
      .rejects.toThrow('Mỗi đơn chỉ được đổi lịch hẹn một lần.');
    expect(f.booking.preferredStartAt).toBe(before);
    expect(f.booking.rescheduleCount).toBe(1);
    expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.audit.logWithManager).not.toHaveBeenCalled();
  });

  it('still lets the description change after the one move, without counting it', async () => {
    const f = harness(1);
    const result = await f.service.reschedule(f.booking.id, f.sameDto, { id: f.booking.customerId });
    expect(result.description).toBe('New words');
    expect(result.rescheduleCount).toBe(1);
  });
});
