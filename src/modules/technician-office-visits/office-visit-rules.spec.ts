import { describe, expect, it } from 'vitest';
import { computeSlots, deriveReviewStage, isBookableSlot, rankOfficesByDistance, type OfficeSchedule } from './office-visit-rules';

// 2026-11-09 là thứ hai. 01:00 UTC = 08:00 giờ Việt Nam.
const MONDAY_8AM = new Date('2026-11-09T01:00:00Z');
const office: OfficeSchedule = {
  visitDays: [1, 2, 3, 4, 5],
  openTime: '08:00',
  closeTime: '17:00',
  lunchStart: '11:30',
  lunchEnd: '13:30',
  slotMinutes: 60,
  slotCapacity: 2,
};
const vn = (iso: string) => new Date(`${iso}+07:00`).toISOString();

describe('computeSlots', () => {
  it('lists working-day slots in Vietnam time, skipping lunch and weekends', () => {
    const slots = computeSlots(office, { now: MONDAY_8AM, daysAhead: 7, minNoticeHours: 0, booked: [] });
    const starts = slots.map((s) => s.startsAt);
    expect(starts[0]).toBe(vn('2026-11-09T08:00:00'));
    expect(starts).toContain(vn('2026-11-09T10:00:00'));
    expect(starts).not.toContain(vn('2026-11-09T11:00:00')); // 11:00-12:00 chạm giờ nghỉ trưa
    expect(starts).not.toContain(vn('2026-11-09T12:00:00'));
    expect(starts).toContain(vn('2026-11-09T14:00:00'));
    expect(starts).toContain(vn('2026-11-09T16:00:00')); // lượt cuối kết thúc đúng 17:00
    expect(starts).not.toContain(vn('2026-11-09T17:00:00'));
    expect(starts.some((s) => s.startsWith('2026-11-14') || s.startsWith('2026-11-15'))).toBe(false); // thứ bảy, chủ nhật
    expect(starts).toContain(vn('2026-11-16T08:00:00')); // thứ hai tuần sau, trong 7 ngày
  });

  it('drops slots inside the minimum notice and past the horizon', () => {
    const slots = computeSlots(office, { now: MONDAY_8AM, daysAhead: 1, minNoticeHours: 3, booked: [] });
    const starts = slots.map((s) => s.startsAt);
    expect(starts).not.toContain(vn('2026-11-09T10:00:00'));
    expect(starts).toContain(vn('2026-11-09T14:00:00'));
    expect(starts.every((s) => s < vn('2026-11-11T00:00:00'))).toBe(true);
  });

  it('removes a slot once its capacity is used up, and reports what is left', () => {
    const at = new Date(vn('2026-11-09T14:00:00'));
    const one = computeSlots(office, { now: MONDAY_8AM, daysAhead: 1, minNoticeHours: 0, booked: [at] });
    expect(one.find((s) => s.startsAt === at.toISOString())?.remaining).toBe(1);
    const full = computeSlots(office, { now: MONDAY_8AM, daysAhead: 1, minNoticeHours: 0, booked: [at, at] });
    expect(full.some((s) => s.startsAt === at.toISOString())).toBe(false);
    expect(isBookableSlot(office, at, { now: MONDAY_8AM, daysAhead: 1, minNoticeHours: 0, booked: [at, at] })).toBe(false);
    expect(isBookableSlot(office, new Date(vn('2026-11-09T14:10:00')), { now: MONDAY_8AM, daysAhead: 1, minNoticeHours: 0, booked: [] })).toBe(false);
  });

  it('works without a lunch break', () => {
    const slots = computeSlots({ ...office, lunchStart: null, lunchEnd: null }, { now: MONDAY_8AM, daysAhead: 0, minNoticeHours: 0, booked: [] });
    expect(slots.map((s) => s.startsAt)).toContain(vn('2026-11-09T12:00:00'));
  });
});

describe('rankOfficesByDistance', () => {
  const offices = [
    { id: 'far', latitude: 21.03, longitude: 105.85 },
    { id: 'near', latitude: 10.78, longitude: 106.7 },
    { id: 'unknown', latitude: null, longitude: null },
  ];

  it('orders by distance and recommends only the nearest', () => {
    const ranked = rankOfficesByDistance(offices, { latitude: 10.77, longitude: 106.69 });
    expect(ranked.map((o) => o.id)).toEqual(['near', 'far', 'unknown']);
    expect(ranked.map((o) => o.recommended)).toEqual([true, false, false]);
    expect(ranked[0].distanceKm).toBeLessThan(3);
    expect(ranked[2].distanceKm).toBeNull();
  });

  it('recommends nothing when the technician has no location', () => {
    const ranked = rankOfficesByDistance(offices, { latitude: null, longitude: undefined });
    expect(ranked.every((o) => !o.recommended && o.distanceKm === null)).toBe(true);
  });
});

describe('deriveReviewStage', () => {
  const base = {
    onboardingStatus: 'submitted',
    profileVerified: false,
    identityVerified: false,
    kycRejected: false,
    profileRejectionReason: null,
    hasScheduledVisit: false,
    hasAttendedVisit: false,
    missedVisits: 0,
    maxMissedVisits: 2,
  };

  it('walks through the sequence', () => {
    expect(deriveReviewStage(base)).toBe('identity_review');
    expect(deriveReviewStage({ ...base, identityVerified: true })).toBe('visit_required');
    expect(deriveReviewStage({ ...base, identityVerified: true, hasScheduledVisit: true })).toBe('visit_scheduled');
    expect(deriveReviewStage({ ...base, identityVerified: true, hasAttendedVisit: true })).toBe('profile_review');
    expect(deriveReviewStage({ ...base, onboardingStatus: 'approved', profileVerified: true })).toBe('approved');
  });

  it('identity approval alone never means approved', () => {
    expect(deriveReviewStage({ ...base, identityVerified: true })).not.toBe('approved');
  });

  it('allows one more booking after the first miss, then blocks', () => {
    const missed = { ...base, identityVerified: true };
    expect(deriveReviewStage({ ...missed, missedVisits: 1 })).toBe('visit_required');
    expect(deriveReviewStage({ ...missed, missedVisits: 2 })).toBe('visit_blocked');
    expect(deriveReviewStage({ ...missed, missedVisits: 2, hasScheduledVisit: true })).toBe('visit_scheduled'); // admin đã cho đặt lại
  });

  it('keeps the rejected stage apart for identity and profile', () => {
    expect(deriveReviewStage({ ...base, onboardingStatus: 'rejected', kycRejected: true })).toBe('identity_rejected');
    expect(deriveReviewStage({ ...base, identityVerified: true, profileRejectionReason: 'Bằng không hợp lệ' })).toBe('profile_rejected');
  });

  it('has no stage before the application is submitted', () => {
    expect(deriveReviewStage({ ...base, onboardingStatus: 'in_progress' })).toBeNull();
  });
});
