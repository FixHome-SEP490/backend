import { haversineKm } from '../../shared/utils/geo';
import { VN_OFFSET_MS, vnParts } from '../../shared/utils/vn-time';

export interface OfficeSchedule {
  visitDays: number[];
  openTime: string;
  closeTime: string;
  lunchStart: string | null;
  lunchEnd: string | null;
  slotMinutes: number;
  slotCapacity: number;
}

export interface VisitSlot {
  /** ISO, đầu lượt. */
  startsAt: string;
  remaining: number;
}

const minutesOf = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

/** Mốc UTC của `minutes` phút trong ngày (giờ Việt Nam) `year-month-day`. */
const vnInstant = (year: number, month: number, day: number, minutes: number): Date =>
  new Date(Date.UTC(year, month - 1, day, 0, minutes) - VN_OFFSET_MS);

/**
 * Các lượt còn nhận của một trụ sở: theo ngày làm việc, giờ mở/đóng, nghỉ trưa, độ dài lượt, trong `daysAhead` ngày,
 * cách hiện tại ít nhất `minNoticeHours`, trừ các lượt đã đặt theo sức chứa. Giờ tính theo giờ Việt Nam.
 */
export function computeSlots(
  office: OfficeSchedule,
  opts: { now: Date; daysAhead: number; minNoticeHours: number; booked: Date[] },
): VisitSlot[] {
  const open = minutesOf(office.openTime);
  const close = minutesOf(office.closeTime);
  const lunchStart = office.lunchStart ? minutesOf(office.lunchStart) : null;
  const lunchEnd = office.lunchEnd ? minutesOf(office.lunchEnd) : null;
  const earliest = opts.now.getTime() + opts.minNoticeHours * 3_600_000;
  const taken = new Map<number, number>();
  for (const at of opts.booked) taken.set(at.getTime(), (taken.get(at.getTime()) ?? 0) + 1);

  const today = vnParts(opts.now);
  const slots: VisitSlot[] = [];
  for (let offset = 0; offset <= opts.daysAhead; offset += 1) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const isoWeekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (!office.visitDays.includes(isoWeekday)) continue;
    for (let start = open; start + office.slotMinutes <= close; start += office.slotMinutes) {
      const end = start + office.slotMinutes;
      if (lunchStart !== null && lunchEnd !== null && start < lunchEnd && end > lunchStart) continue;
      const at = vnInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), start);
      if (at.getTime() < earliest) continue;
      const remaining = office.slotCapacity - (taken.get(at.getTime()) ?? 0);
      if (remaining > 0) slots.push({ startsAt: at.toISOString(), remaining });
    }
  }
  return slots;
}

/** Giờ `at` có đúng là một lượt hợp lệ còn chỗ của trụ sở không. */
export function isBookableSlot(
  office: OfficeSchedule,
  at: Date,
  opts: { now: Date; daysAhead: number; minNoticeHours: number; booked: Date[] },
): boolean {
  return computeSlots(office, opts).some((slot) => new Date(slot.startsAt).getTime() === at.getTime());
}

/** Trụ sở sắp theo khoảng cách từ `from`; trụ sở gần nhất được đánh dấu `recommended`. Không có toạ độ thì không tính khoảng cách. */
export function rankOfficesByDistance<T extends { latitude: number | null; longitude: number | null }>(
  offices: T[],
  from: { latitude: number | null | undefined; longitude: number | null | undefined },
): Array<T & { distanceKm: number | null; recommended: boolean }> {
  const hasFrom = from.latitude != null && from.longitude != null;
  const withDistance = offices.map((office) => ({
    ...office,
    distanceKm:
      hasFrom && office.latitude != null && office.longitude != null
        ? Math.round(haversineKm(Number(from.latitude), Number(from.longitude), office.latitude, office.longitude) * 10) / 10
        : null,
  }));
  withDistance.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  return withDistance.map((office, index) => ({ ...office, recommended: index === 0 && office.distanceKm !== null }));
}

export type ReviewStage =
  | 'identity_review'
  | 'visit_required'
  | 'visit_scheduled'
  | 'visit_blocked'
  | 'profile_review'
  | 'approved'
  | 'identity_rejected'
  | 'profile_rejected';

/**
 * Giai đoạn xét duyệt của thợ đã nộp hồ sơ. Tính ra từ dữ liệu, không lưu: app cũ vẫn chỉ thấy `onboardingStatus = submitted`.
 */
export function deriveReviewStage(input: {
  onboardingStatus: string;
  profileVerified: boolean;
  identityVerified: boolean;
  kycRejected: boolean;
  profileRejectionReason: string | null;
  hasScheduledVisit: boolean;
  hasAttendedVisit: boolean;
  missedVisits: number;
  maxMissedVisits: number;
}): ReviewStage | null {
  if (input.onboardingStatus === 'approved' || input.profileVerified) return 'approved';
  if (input.onboardingStatus !== 'submitted' && input.onboardingStatus !== 'rejected') return null;
  if (input.kycRejected) return 'identity_rejected';
  if (input.profileRejectionReason) return 'profile_rejected';
  if (!input.identityVerified) return 'identity_review';
  if (input.hasAttendedVisit) return 'profile_review';
  if (input.hasScheduledVisit) return 'visit_scheduled';
  return input.missedVisits >= input.maxMissedVisits ? 'visit_blocked' : 'visit_required';
}
