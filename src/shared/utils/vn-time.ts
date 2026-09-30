/**
 * Vietnam wall-clock time, independent of the server's time zone.
 *
 * FixHome only operates in Vietnam, and Vietnam has kept a fixed UTC+07:00
 * offset with no daylight saving since 1975, so shifting by seven hours and
 * reading the UTC fields gives the local clock exactly. Using the process's
 * local time instead silently breaks in Docker, whose images default to UTC.
 */
export const VN_TIME_ZONE = 'Asia/Ho_Chi_Minh';
export const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface VnParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
}

export function vnParts(input: Date | string | number): VnParts {
  const shifted = new Date(new Date(input).getTime() + VN_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** dd/MM/yyyy in Vietnam time. */
export function formatVnDate(input: Date | string | number): string {
  const p = vnParts(input);
  return `${pad(p.day)}/${pad(p.month)}/${p.year}`;
}

/** Whole years between a calendar birth date (yyyy-MM-dd) and today in Vietnam. */
export function ageInYearsOnVnToday(
  dateOfBirth: string,
  now: Date = new Date(),
): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth);
  if (!match) return Number.NaN;
  const [birthYear, birthMonth, birthDay] = match.slice(1).map(Number);
  const today = vnParts(now);
  const hadBirthday =
    today.month > birthMonth ||
    (today.month === birthMonth && today.day >= birthDay);
  return today.year - birthYear - (hadBirthday ? 0 : 1);
}
