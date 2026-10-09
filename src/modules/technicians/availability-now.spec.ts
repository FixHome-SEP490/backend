import { describe, expect, it } from 'vitest';
import { availabilityNow } from './availability-now';

// Mon-Sat 08:00-18:00, Vietnam time. 2026-10-12 is a Monday.
const week = [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: '08:00', endTime: '18:00' }));
const vn = (iso: string) => new Date(`${iso}+07:00`);

describe('availability from the weekly schedule (PO 08/10/2026)', () => {
  it('receives jobs inside the schedule until its end', () => {
    const r = availabilityNow({ manual: true, schedules: week, timeOff: [], now: vn('2026-10-12T09:30:00') });
    expect(r).toMatchObject({ state: 'receiving', receiving: true });
    expect(r.until?.toISOString()).toBe(vn('2026-10-12T18:00:00').toISOString());
    expect(r.nextStartAt?.toISOString()).toBe(vn('2026-10-13T08:00:00').toISOString());
  });

  it('switches off by itself outside the schedule and says when it switches back on', () => {
    const evening = availabilityNow({ manual: true, schedules: week, timeOff: [], now: vn('2026-10-12T19:00:00') });
    expect(evening).toMatchObject({ state: 'off_hours', receiving: false, until: null });
    expect(evening.nextStartAt?.toISOString()).toBe(vn('2026-10-13T08:00:00').toISOString());
    // Saturday evening: no Sunday hours, back on Monday morning.
    const weekend = availabilityNow({ manual: true, schedules: week, timeOff: [], now: vn('2026-10-17T20:00:00') });
    expect(weekend.nextStartAt?.toISOString()).toBe(vn('2026-10-19T08:00:00').toISOString());
  });

  it('the manual switch only pauses', () => {
    expect(availabilityNow({ manual: false, schedules: week, timeOff: [], now: vn('2026-10-12T09:30:00') })).toMatchObject({ state: 'paused', receiving: false });
  });

  it('time off wins and the next start skips the days off', () => {
    const timeOff = [{ startAt: vn('2026-10-12T00:00:00'), endAt: vn('2026-10-14T00:00:00') }];
    const r = availabilityNow({ manual: true, schedules: week, timeOff, now: vn('2026-10-12T09:30:00') });
    expect(r).toMatchObject({ state: 'time_off', receiving: false });
    expect(r.until?.toISOString()).toBe(vn('2026-10-14T00:00:00').toISOString());
    expect(r.nextStartAt?.toISOString()).toBe(vn('2026-10-14T08:00:00').toISOString());
  });

  it('without a schedule nothing switches on', () => {
    expect(availabilityNow({ manual: true, schedules: [], timeOff: [], now: vn('2026-10-12T09:30:00') })).toMatchObject({ state: 'no_schedule', receiving: false, nextStartAt: null });
  });
});
