import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { InterruptionRebookDto } from './interruption-rebook.dto';
import { InterruptionDraftQueryDto } from './interruption-draft-query.dto';

const base = (count = 1) => ({ idempotencyKey: randomUUID(), addressId: randomUUID(),
  items: Array.from({ length: count }, () => ({ sourceBookingId: randomUUID(), sourceCaseId: randomUUID() })) });
const errors = (schedule: object, count = 1) => validateSync(plainToInstance(InterruptionRebookDto,
  { ...base(count), ...schedule }), { whitelist: true, forbidNonWhitelisted: true });

describe('interruption rebook schedule HTTP contract', () => {
  it.each([
    { date: '2030-10-29', slot: 'afternoon' },
    { mode: 'scheduled', date: '2030-10-29', slot: 'afternoon' },
    { mode: 'urgent' },
  ])('accepts %j', schedule => expect(errors(schedule)).toEqual([]));

  it.each([
    {}, { mode: 'scheduled' }, { mode: 'now' }, { mode: null },
    { mode: 'urgent', date: '2030-10-29' }, { mode: 'urgent', slot: 'afternoon' },
    { mode: 'urgent', date: null }, { mode: 'urgent', slot: null },
    { mode: 'scheduled', date: '2030-10-29' }, { date: '2030-10-29', slot: 'night' },
  ])('rejects missing or contradictory schedule %j', schedule => expect(errors(schedule).length).toBeGreaterThan(0));

  it('accepts five interruption sources and rejects a sixth', () => {
    const schedule = { date: '2030-10-29', slot: 'afternoon' };
    expect(errors(schedule, 5)).toEqual([]);
    expect(errors(schedule, 6).some(error => error.property === 'items' && error.constraints?.arrayMaxSize)).toBe(true);
  });

  it('accepts five selected interruption draft sources and rejects a sixth', () => {
    const sourceBookingIds = (count: number) => Array.from({ length: count }, () => randomUUID());
    const five = validateSync(plainToInstance(InterruptionDraftQueryDto, { sourceBookingIds: sourceBookingIds(5) }));
    const six = validateSync(plainToInstance(InterruptionDraftQueryDto, { sourceBookingIds: sourceBookingIds(6) }));
    expect(five).toEqual([]);
    expect(six.some(error => error.property === 'sourceBookingIds' && error.constraints?.arrayMaxSize)).toBe(true);
  });
});
