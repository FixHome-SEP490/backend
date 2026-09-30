import { describe, expect, it } from 'vitest';
import { ageInYearsOnVnToday, formatVnDate, vnParts } from './vn-time';

describe('vn-time', () => {
  it('reads the Vietnam clock from a UTC instant', () => {
    expect(vnParts('2026-09-30T17:30:00Z')).toEqual({
      year: 2026,
      month: 10,
      day: 1,
      hour: 0,
      minute: 30,
      second: 0,
      weekday: 4,
    });
  });

  it('formats the Vietnam date, not the server date, near midnight', () => {
    // 23:59 UTC on 30/09 is already 06:59 on 01/10 in Vietnam.
    expect(formatVnDate('2026-09-30T23:59:00Z')).toBe('01/10/2026');
    // 16:59 UTC is still 23:59 on the same day in Vietnam.
    expect(formatVnDate('2026-09-30T16:59:00Z')).toBe('30/09/2026');
  });

  it('counts age by the birthday in Vietnam', () => {
    // 17:00 UTC on 14/06 is 00:00 on 15/06 in Vietnam: the birthday has come.
    expect(ageInYearsOnVnToday('2008-06-15', new Date('2026-06-14T17:00:00Z'))).toBe(18);
    expect(ageInYearsOnVnToday('2008-06-15', new Date('2026-06-14T16:59:00Z'))).toBe(17);
    expect(ageInYearsOnVnToday('2008-06-15T00:00:00.000Z', new Date('2026-07-01T00:00:00Z'))).toBe(18);
  });

  it('refuses a birth date it cannot read', () => {
    expect(ageInYearsOnVnToday('15/06/2008')).toBeNaN();
  });
});
