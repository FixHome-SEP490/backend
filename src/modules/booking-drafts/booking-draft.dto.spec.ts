import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { parseSafeDraftSnapshot, parseDraftSubmit, SaveBookingDraftDto } from './booking-draft.dto';

describe('safe manual booking draft input', () => {
  it.each([0, 1, 2, 3, 4, 5])('allows %i partial devices without booking requirements', count => {
    const snapshot = { items: Array.from({ length: count }, () => ({ description: 'Máy không chạy' })) };
    expect(parseSafeDraftSnapshot(snapshot)).toEqual(snapshot);
  });

  it.each([
    { items: Array.from({ length: 6 }, () => ({})) },
    { address: 'Full customer address' }, { price: 100 }, { aiTranscript: 'text' },
    { items: [{ photoUploadIds: ['https://private.test/signed'] }] },
    { items: [{ description: 'https://private.test/signed?token=secret' }] },
    { customerNote: 'a'.repeat(1001) }, { items: [{ deviceLabel: 'a'.repeat(81) }] },
    { items: [{ deviceAttributes: { secret: 'value' } }] },
    { items: [{ photoUploadIds: [randomUUID(), ...Array(7).fill(randomUUID())] }] },
    { items: [{ description: 'a'.repeat(5001) }] }, { items: [null] },
    { mode: 'now' }, { customerNote: 'bad\u0000text' }, { items: [{ serviceId: 'invalid' }] },
    { nested: { nested: { nested: { nested: { nested: { nested: { nested: { nested: {} } } } } } } } },
  ])('rejects unsafe or oversized snapshot %j', snapshot => {
    expect(() => parseSafeDraftSnapshot(snapshot)).toThrow();
  });

  it('validates bounded device attributes and normalizes reference UUIDs', () => {
    const id = randomUUID();
    expect(parseSafeDraftSnapshot({ addressId: id.toUpperCase(), items: [{ serviceId: id,
      deviceAttributes: { brand: 'LG', washerCapacityKg: 9, washerHasDryer: true } }] }).addressId).toBe(id);
    expect(() => parseSafeDraftSnapshot({ items: [{ deviceAttributes: { brand: 'a'.repeat(65) } }] })).toThrow();
  });

  it('restores only bounded flat metadata and omits unselected variants', () => {
    expect(parseSafeDraftSnapshot({ kind: 'visit_group', savedDeviceCount: 1, quantity: 1, step: 4,
      items: [{ selectedVariantCode: null }, { description: 'Đang soạn' }] })).toEqual({
      kind: 'visit_group', savedDeviceCount: 1, quantity: 1, step: 4, items: [{}, { description: 'Đang soạn' }],
    });
    for (const metadata of [{ kind: 'cart' }, { savedDeviceCount: -1 }, { savedDeviceCount: 6 },
      { savedDeviceCount: 1.5 }, { savedDeviceCount: 2, items: [{}] },
      { savedDeviceCount: 0, items: [{}, {}] }, { step: 0 }, { step: 5 }, { step: '1' },
      { quantity: 0 }, { quantity: 1001 }, { quantity: 1.5 },
      { activeDevice: {} }, { extraDevices: [] }, { selectedAddressId: randomUUID() }, { schedule: {} }]) {
      expect(() => parseSafeDraftSnapshot(metadata)).toThrow();
    }
  });

  it('requires an explicit null or positive version, including through the HTTP DTO', () => {
    for (const expectedVersion of [undefined, -1, 0, 1.5, '1', 2147483647]) {
      expect(validateSync(plainToInstance(SaveBookingDraftDto, { snapshot: {}, expectedVersion })).length).toBeGreaterThan(0);
    }
    for (const expectedVersion of [null, 1, 20]) {
      expect(validateSync(plainToInstance(SaveBookingDraftDto, { snapshot: {}, expectedVersion }))).toEqual([]);
    }
  });

  it('validates submit using the real discriminated create DTOs', () => {
    const common = { addressId: randomUUID(), mode: 'scheduled', date: '2030-11-05', slot: 'morning' };
    const solo = { kind: 'booking', data: { ...common, serviceId: randomUUID(), quantity: 1 } };
    const group = { kind: 'visit_group', data: { ...common, items: [{ serviceId: randomUUID() }] } };
    expect(parseDraftSubmit(solo).kind).toBe('booking');
    expect(parseDraftSubmit(group).kind).toBe('visit_group');
    for (const invalid of [{ kind: 'booking', data: common }, { kind: 'booking', data: { ...solo.data, items: [] } },
      { kind: 'visit_group', data: { ...group.data, items: Array(6).fill(group.data.items[0]) } },
      { kind: 'visit_group', data: { ...group.data, items: [] } },
      { kind: 'cart', data: solo.data }, { ...solo, customerId: randomUUID() },
      { kind: 'booking', data: { ...solo.data, mediaUrls: Array(10000).fill('x') } }]) {
      expect(() => parseDraftSubmit(invalid)).toThrow();
    }
  });
});
