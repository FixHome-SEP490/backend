/**
 * Booking sessions (PO 08/10/2026). A scheduled booking takes one session of
 * one day in Vietnam time: morning 08:00-12:00 or afternoon 13:00-18:00. A
 * technician holds at most one scheduled booking per session, so at most two
 * a day. An urgent booking is "come now": its window starts at creation.
 */
export type BookingSlot = 'morning' | 'afternoon';
export type BookingMode = 'scheduled' | 'urgent';

export const BOOKING_SLOTS: Record<BookingSlot, { startHour: number; endHour: number; label: string }> = {
  morning: { startHour: 8, endHour: 12, label: 'Buổi sáng (8:00 - 12:00)' },
  afternoon: { startHour: 13, endHour: 18, label: 'Buổi chiều (13:00 - 18:00)' },
};

const VN_OFFSET_MS = 7 * 3600_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD of `at` in Vietnam time. */
export function vnDate(at: Date): string {
  return new Date(at.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instants of a session on a Vietnam calendar day; null for an invalid date. */
export function slotWindow(date: string, slot: BookingSlot): { start: Date; end: Date } | null {
  const m = DATE_RE.exec(date);
  if (!m || !BOOKING_SLOTS[slot]) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  const { startHour, endHour } = BOOKING_SLOTS[slot];
  return {
    start: new Date(Date.UTC(y, mo - 1, d, startHour) - VN_OFFSET_MS),
    end: new Date(Date.UTC(y, mo - 1, d, endHour) - VN_OFFSET_MS),
  };
}

/** The session containing `at`, if any. */
export function slotAt(at: Date): { date: string; slot: BookingSlot } | null {
  const date = vnDate(at);
  for (const slot of Object.keys(BOOKING_SLOTS) as BookingSlot[]) {
    const w = slotWindow(date, slot)!;
    if (at >= w.start && at < w.end) return { date, slot };
  }
  return null;
}

/**
 * The session a booking occupies: its own slot column, else (bookings made
 * before sessions existed) the session that fully contains its window.
 */
export function bookingSession(b: { slot?: string | null; preferredStartAt?: Date | string | null; preferredEndAt?: Date | string | null }): { date: string; slot: BookingSlot } | null {
  if (!b.preferredStartAt) return null;
  const start = new Date(b.preferredStartAt);
  if (b.slot === 'morning' || b.slot === 'afternoon') return { date: vnDate(start), slot: b.slot };
  const inside = slotAt(start);
  if (!inside || !b.preferredEndAt) return null;
  const w = slotWindow(inside.date, inside.slot)!;
  return new Date(b.preferredEndAt) <= w.end ? inside : null;
}

export const sameSession = (a: { date: string; slot: BookingSlot } | null, b: { date: string; slot: BookingSlot } | null) =>
  !!a && !!b && a.date === b.date && a.slot === b.slot;

/**
 * The window a booking request asks for. Scheduled: the whole session, which
 * must not have started yet. Urgent: from now for `urgentMinutes`. Without a
 * mode the legacy explicit window is kept (older clients), its session read
 * from the window.
 */
export function resolveBookingWindow(
  input: { mode?: string; date?: string; slot?: string; preferredStartAt?: string; preferredEndAt?: string },
  now: Date,
  urgentMinutes: number,
): { mode: BookingMode; slot: BookingSlot | null; start: Date; end: Date } | { error: string } {
  if (input.mode === 'urgent') {
    return { mode: 'urgent', slot: null, start: now, end: new Date(now.getTime() + urgentMinutes * 60_000) };
  }
  if (input.mode === 'scheduled' || input.slot || input.date) {
    if (!input.date || (input.slot !== 'morning' && input.slot !== 'afternoon')) return { error: 'Chọn ngày và buổi (sáng hoặc chiều)' };
    const w = slotWindow(input.date, input.slot);
    if (!w) return { error: 'Ngày hẹn không hợp lệ' };
    if (w.start.getTime() <= now.getTime()) return { error: 'Buổi này đã bắt đầu, chọn buổi sau' };
    return { mode: 'scheduled', slot: input.slot, start: w.start, end: w.end };
  }
  const start = input.preferredStartAt ? new Date(input.preferredStartAt) : null;
  const end = input.preferredEndAt ? new Date(input.preferredEndAt) : null;
  if (!start || !end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end || start.getTime() <= now.getTime() - 120_000) {
    return { error: 'Vui lòng chọn khung giờ hẹn trong tương lai (Choose a valid future start and end time)' };
  }
  return { mode: 'scheduled', slot: bookingSession({ preferredStartAt: start, preferredEndAt: end })?.slot ?? null, start, end };
}
