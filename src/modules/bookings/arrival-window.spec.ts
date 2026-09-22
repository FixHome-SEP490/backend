import { describe, expect, it } from 'vitest';
import { hasAvailableArrival, type ArrivalSchedule } from './arrival-window';

// Local Vietnam wall-clock time: 2030-10-15T10:00+07:00 == 2030-10-15T03:00Z.
const booking = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });
const shift = (startTime: string, endTime: string, dayOfWeek = 2): ArrivalSchedule[] =>
  [{ dayOfWeek, startTime, endTime }]; // 2030-10-15 is Tuesday
const block = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });

describe('ARRIVAL possible slot = booking window intersect working shifts minus time-off and assigned bookings', () => {
  it('allows a late shift partial overlap: customer 17-19, technician shift 08-18', () => {
    expect(hasAvailableArrival(booking('2030-10-15T10:00:00Z', '2030-10-15T12:00:00Z'), shift('08:00','18:00'), [])).toBe(true);
  });
  it('rejects customer 18-19 when shift ends exactly at 18 (no positive arrival interval)', () => {
    expect(hasAvailableArrival(booking('2030-10-15T11:00:00Z', '2030-10-15T12:00:00Z'), shift('08:00','18:00'), [])).toBe(false);
  });
  it('accepts early shift overlap 07-09 for technician shift 08-18', () => {
    expect(hasAvailableArrival(booking('2030-10-15T00:00:00Z', '2030-10-15T02:00:00Z'), shift('08:00','18:00'), [])).toBe(true);
  });
  it('accepts a remaining arrival interval after a partial TimeOff or other assigned booking', () => {
    const window = booking('2030-10-15T03:00:00Z', '2030-10-15T05:00:00Z');
    const unavailable = [block('2030-10-15T03:00:00Z', '2030-10-15T04:00:00Z')];
    expect(hasAvailableArrival(window, shift('08:00','18:00'), unavailable)).toBe(true);
  });
  it('rejects overlapping blocked intervals whose union covers every arrival instant', () => {
    const window = booking('2030-10-15T03:00:00Z', '2030-10-15T05:00:00Z');
    const unavailable = [block('2030-10-15T03:00:00Z','2030-10-15T04:30:00Z'), block('2030-10-15T04:00:00Z','2030-10-15T05:00:00Z')];
    expect(hasAvailableArrival(window, shift('08:00','18:00'), unavailable)).toBe(false);
  });
  it('accepts an exact shared boundary after a blocked interval ends, without overlapping it', () => {
    const window = booking('2030-10-15T03:00:00Z', '2030-10-15T05:00:00Z');
    expect(hasAvailableArrival(window, shift('08:00','18:00'), [block('2030-10-15T03:00:00Z','2030-10-15T04:00:00Z')])).toBe(true);
  });
  it('checks the next local day shift for an overnight customer arrival window', () => {
    const window = booking('2030-10-15T16:00:00Z', '2030-10-16T02:00:00Z'); // Tue 23:00 to Wed 09:00
    expect(hasAvailableArrival(window, shift('08:00','18:00',3), [])).toBe(true);
    expect(hasAvailableArrival(window, shift('09:00','18:00',3), [])).toBe(false);
  });
  it('rejects missing schedules, reversed windows, invalid dates and an entirely off-duty window', () => {
    const window = booking('2030-10-15T03:00:00Z', '2030-10-15T04:00:00Z');
    expect(hasAvailableArrival(window, [], [])).toBe(false);
    expect(hasAvailableArrival(booking('2030-10-15T04:00:00Z','2030-10-15T03:00:00Z'), shift('08:00','18:00'), [])).toBe(false);
    expect(hasAvailableArrival({ start: new Date('invalid'), end: window.end }, shift('08:00','18:00'), [])).toBe(false);
    expect(hasAvailableArrival(window, shift('15:00','18:00'), [])).toBe(false);
  });
});