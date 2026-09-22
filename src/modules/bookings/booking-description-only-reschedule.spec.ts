import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BookingStatus } from '../../shared/enums';
import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';

function harness(status: BookingStatus = BookingStatus.MATCHING) {
  const start = new Date(Date.now() + 2 * 86_400_000);
  const end = new Date(start.getTime() + 4 * 3_600_000);
  const booking = {
    id: 'booking-description-only', customerId: 'synthetic-owner', status,
    description: 'Old description', preferredStartAt: start, preferredEndAt: end,
  };
  const queryBuilder = {
    update: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(), execute: vi.fn(async () => ({ affected: 2 })),
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
  const dto = { preferredStartAt: start.toISOString(), preferredEndAt: end.toISOString(), description: 'Updated description' };
  return { booking, manager, audit, service, dto, queryBuilder };
}

describe('pre-Accept description-only update must not reset matching', () => {
  it.each([BookingStatus.MATCHING, BookingStatus.SUBMITTED])('preserves current group and status on identical window (%s)', async status => {
    const f = harness(status);
    const unchangedStart = f.booking.preferredStartAt;
    const unchangedEnd = f.booking.preferredEndAt;
    const result = await f.service.reschedule(f.booking.id, f.dto, { id: f.booking.customerId });
    expect(result.status).toBe(status);
    expect(result.description).toBe('Updated description');
    expect(result.preferredStartAt).toBe(unchangedStart);
    expect(result.preferredEndAt).toBe(unchangedEnd);
    expect(f.manager.createQueryBuilder).not.toHaveBeenCalled();
    expect(f.manager.save).toHaveBeenCalledTimes(1);
    expect(f.audit.logWithManager).toHaveBeenCalledTimes(1);
  });

  it('cancels old invitations and goes back to SUBMITTED when the customer really changes the window', async () => {
    const f = harness();
    const newStart = new Date(f.booking.preferredStartAt.getTime() + 3_600_000);
    const dto = { ...f.dto, preferredStartAt: newStart.toISOString(),
      preferredEndAt: new Date(newStart.getTime() + 4 * 3_600_000).toISOString() };
    const result = await f.service.reschedule(f.booking.id, dto, { id: f.booking.customerId });
    expect(result.status).toBe(BookingStatus.SUBMITTED);
    expect(f.manager.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(f.queryBuilder.execute).toHaveBeenCalledTimes(1);
    expect(f.manager.save).toHaveBeenCalledTimes(1);
  });
});