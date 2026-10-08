import { describe, expect, it } from 'vitest';
import { bookingSession, sameSession, slotAt, slotWindow, vnDate } from './booking-slots';

describe('booking sessions in Vietnam time', () => {
  it('maps morning and afternoon to 08-12 and 13-18 UTC+7', () => {
    const m = slotWindow('2026-10-20', 'morning')!;
    expect(m.start.toISOString()).toBe('2026-10-20T01:00:00.000Z');
    expect(m.end.toISOString()).toBe('2026-10-20T05:00:00.000Z');
    const a = slotWindow('2026-10-20', 'afternoon')!;
    expect(a.start.toISOString()).toBe('2026-10-20T06:00:00.000Z');
    expect(a.end.toISOString()).toBe('2026-10-20T11:00:00.000Z');
  });

  it('rejects impossible dates', () => {
    expect(slotWindow('2026-02-30', 'morning')).toBeNull();
    expect(slotWindow('20-10-2026', 'morning')).toBeNull();
  });

  it('knows the session of an instant, and that 12:00-13:00 and evenings are outside sessions', () => {
    expect(slotAt(new Date('2026-10-20T02:30:00Z'))).toEqual({ date: '2026-10-20', slot: 'morning' });
    expect(slotAt(new Date('2026-10-20T05:30:00Z'))).toBeNull();
    expect(slotAt(new Date('2026-10-20T13:00:00Z'))).toBeNull();
    expect(vnDate(new Date('2026-10-20T18:30:00Z'))).toBe('2026-10-21');
  });

  it('reads the session of old bookings from their window', () => {
    expect(bookingSession({ preferredStartAt: '2026-10-20T02:00:00Z', preferredEndAt: '2026-10-20T04:00:00Z' })).toEqual({ date: '2026-10-20', slot: 'morning' });
    expect(bookingSession({ preferredStartAt: '2026-10-20T04:00:00Z', preferredEndAt: '2026-10-20T07:00:00Z' })).toBeNull();
    expect(bookingSession({ slot: 'afternoon', preferredStartAt: '2026-10-20T06:00:00Z' })).toEqual({ date: '2026-10-20', slot: 'afternoon' });
    expect(sameSession({ date: '2026-10-20', slot: 'morning' }, { date: '2026-10-20', slot: 'morning' })).toBe(true);
    expect(sameSession(null, { date: '2026-10-20', slot: 'morning' })).toBe(false);
  });
});

import { servesArea, technicianOrigin } from './technician-location';

describe('technician area and origin', () => {
  const booking = { provinceSnapshot: '79', districtSnapshot: '760' };
  it('compares district codes only within one code system', () => {
    expect(servesArea([], booking)).toBe(true);
    expect(servesArea([{ provinceCode: '01', districtCode: '001' }], booking)).toBe(false);
    expect(servesArea([{ provinceCode: '79', districtCode: '761' }], booking)).toBe(false);
    expect(servesArea([{ provinceCode: '79', districtCode: '760' }], booking)).toBe(true);
    // post-2025 ward codes cannot be compared with a pre-2025 district code: radius decides
    expect(servesArea([{ provinceCode: '79', districtCode: '26743' }], booking)).toBe(true);
    expect(servesArea([{ provinceCode: '79', districtCode: '26743' }], { provinceSnapshot: '79', districtSnapshot: '26740' })).toBe(false);
  });
  it('uses a fresh GPS fix only for urgent bookings', () => {
    const now = Date.parse('2026-10-08T10:00:00Z');
    const profile = { lastLat: 10.8, lastLng: 106.7, lastLocationAt: new Date(now - 5 * 60_000) };
    const address = { lat: 10.7, lng: 106.6 };
    expect(technicianOrigin('urgent', profile, address, 15, now)?.source).toBe('gps');
    expect(technicianOrigin('scheduled', profile, address, 15, now)?.source).toBe('address');
    expect(technicianOrigin('urgent', { ...profile, lastLocationAt: new Date(now - 20 * 60_000) }, address, 15, now)?.source).toBe('address');
    expect(technicianOrigin('urgent', profile, null, 15, now)?.source).toBe('gps');
    expect(technicianOrigin('scheduled', profile, null, 15, now)).toBeNull();
  });
});
