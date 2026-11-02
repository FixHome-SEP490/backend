import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { InterruptionRebookDto } from './interruption-rebook.dto';

const base = () => ({ idempotencyKey: randomUUID(), addressId: randomUUID(),
  items: [{ sourceBookingId: randomUUID(), sourceCaseId: randomUUID() }] });
const errors = (schedule: object) => validateSync(plainToInstance(InterruptionRebookDto,
  { ...base(), ...schedule }), { whitelist: true, forbidNonWhitelisted: true });

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
});
