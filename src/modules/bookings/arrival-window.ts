/** Customer interval represents a POSSIBLE ARRIVAL window, not repair duration. */
export type ArrivalInterval = { start: Date; end: Date };
export type ArrivalSchedule = { dayOfWeek: number; startTime: string; endTime: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
// Defensive CPU bound on externally provided booking windows; ordinary visits span hours.
const MAX_DAYS = 3660;

function localClockMinutes(value: string, allowDayEnd = false): number | null {
  const result = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.slice(0, 5));
  if (allowDayEnd && value.slice(0, 5) === '24:00') return 24 * 60;
  return result ? Number(result[1]) * 60 + Number(result[2]) : null;
}

/** All intervals are half-open [start,end); touching endpoints never count as overlap. */
export function hasAvailableArrival(
  window: ArrivalInterval,
  schedules: ArrivalSchedule[],
  unavailable: ArrivalInterval[],
): boolean {
  const start = window.start?.getTime();
  const end = window.end?.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
      end - start > MAX_DAYS * DAY_MS || !schedules.length) return false;

  const blocked = unavailable.map(interval => ({ start: interval.start?.getTime(), end: interval.end?.getTime() }));
  if (blocked.some(i => !Number.isFinite(i.start) || !Number.isFinite(i.end) || i.start! >= i.end!)) return false;
  blocked.sort((a, b) => a.start! - b.start!);

  // Include the day before the customer's start: a shift may cross midnight.
  const localDayStart = Math.floor((start + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS;
  for (let day = localDayStart - DAY_MS; day < end; day += DAY_MS) {
    const weekday = new Date(day + VN_OFFSET_MS).getUTCDay();
    for (const shift of schedules) {
      if (shift.dayOfWeek !== weekday) continue;
      const from = localClockMinutes(shift.startTime);
      const to = localClockMinutes(shift.endTime, true);
      if (from === null || to === null || from === to) continue;
      const shiftStart = day + from * 60000;
      const shiftEnd = day + to * 60000 + (to < from ? DAY_MS : 0);
      const left = Math.max(start, shiftStart);
      const right = Math.min(end, shiftEnd);
      if (left >= right) continue;
      let cursor = left;
      for (const busy of blocked) {
        if (busy.end! <= cursor) continue;
        if (busy.start! >= right) break;
        if (busy.start! > cursor) return true;
        cursor = Math.max(cursor, busy.end!);
        if (cursor >= right) break;
      }
      if (cursor < right) return true;
    }
  }
  return false;
}