import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { RepairFailureRebookDto } from './repair-failure-rebook.dto';

describe('repair-failure rebook item limit', () => {
  it('accepts five failed sources and rejects a sixth', () => {
    const payload = (count: number) => ({
      idempotencyKey: 'repair-rebook-01',
      addressId: randomUUID(),
      date: '2030-10-29',
      slot: 'afternoon',
      items: Array.from({ length: count }, () => ({ sourceBookingId: randomUUID(), sourceIncidentId: randomUUID() })),
    });
    const five = validateSync(plainToInstance(RepairFailureRebookDto, payload(5)));
    const six = validateSync(plainToInstance(RepairFailureRebookDto, payload(6)));
    expect(five).toEqual([]);
    expect(six.some(error => error.property === 'items' && error.constraints?.arrayMaxSize)).toBe(true);
  });
});
