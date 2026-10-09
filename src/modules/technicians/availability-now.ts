/**
 * Whether a technician receives new jobs right now (PO 08/10/2026): the weekly
 * schedule switches them on and off by itself; the manual switch only pauses;
 * time off wins over both. Days and clock times are Vietnam time.
 */
export interface WeeklySlot { dayOfWeek: number; startTime: string; endTime: string }
export interface TimeOffSpan { startAt: Date | string; endAt: Date | string }
export type AvailabilityState = 'receiving' | 'paused' | 'off_hours' | 'time_off' | 'no_schedule';

export interface AvailabilityNow {
  state: AvailabilityState;
  receiving: boolean;
  /** End of the current working window, or of the time off. */
  until: Date | null;
  /** Next time the schedule switches them on (not inside a time off). */
  nextStartAt: Date | null;
}

const VN_OFFSET_MS = 7 * 3600_000;
const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** The instant a Vietnam clock time happens on the Vietnam day that is `dayOffset` days after `now`'s. */
function vnInstant(now: Date, dayOffset: number, minutes: number): Date {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const midnightUtc = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() + dayOffset);
  return new Date(midnightUtc + minutes * 60_000 - VN_OFFSET_MS);
}

export function availabilityNow(input: { manual: boolean; schedules: WeeklySlot[]; timeOff: TimeOffSpan[]; now?: Date }): AvailabilityNow {
  const now = input.now ?? new Date();
  const spans = input.timeOff.map((t) => ({ start: new Date(t.startAt), end: new Date(t.endAt) }));
  const inTimeOff = (at: Date) => spans.find((s) => s.start <= at && at < s.end);
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const today = vn.getUTCDay();
  const minuteNow = vn.getUTCHours() * 60 + vn.getUTCMinutes();

  // Next scheduled start after `now` within two weeks, skipping starts that fall in a time off.
  let nextStartAt: Date | null = null;
  for (let d = 0; d < 14 && !nextStartAt; d++) {
    const dow = (today + d) % 7;
    const starts = input.schedules
      .filter((s) => s.dayOfWeek === dow)
      .map((s) => vnInstant(now, d, toMinutes(s.startTime)))
      .filter((at) => at > now && !inTimeOff(at))
      .sort((a, b) => a.getTime() - b.getTime());
    nextStartAt = starts[0] ?? null;
  }

  const off = inTimeOff(now);
  if (off) return { state: 'time_off', receiving: false, until: off.end, nextStartAt };
  if (!input.schedules.length) return { state: 'no_schedule', receiving: false, until: null, nextStartAt: null };
  const current = input.schedules.find((s) => s.dayOfWeek === today && toMinutes(s.startTime) <= minuteNow && minuteNow < toMinutes(s.endTime));
  const until = current ? vnInstant(now, 0, toMinutes(current.endTime)) : null;
  if (!input.manual) return { state: 'paused', receiving: false, until, nextStartAt };
  if (!current) return { state: 'off_hours', receiving: false, until: null, nextStartAt };
  return { state: 'receiving', receiving: true, until, nextStartAt };
}
