/**
 * Reputation points (PO 08/10/2026), for customers and technicians alike.
 * Everyone starts at 100; each violation (cancelling an order a technician
 * already holds) costs `reputation.violation_points` (10). The score after the
 * change decides the penalty:
 *   below 70  -> no new bookings / jobs for 72 hours
 *   below 40  -> 7 days
 *   20 or less -> 30 days
 *   0          -> account locked for good
 * Every `reputation.reset_months` (2) months the score goes back to 100; a
 * locked account stays locked.
 */
export type ReputationPenalty =
  | { kind: 'none' }
  | { kind: 'suspend'; hours: number; label: string }
  | { kind: 'lock' };

export const REPUTATION_START = 100;

export function penaltyFor(points: number): ReputationPenalty {
  if (points <= 0) return { kind: 'lock' };
  if (points <= 20) return { kind: 'suspend', hours: 30 * 24, label: '30 ngày' };
  if (points < 40) return { kind: 'suspend', hours: 7 * 24, label: '7 ngày' };
  if (points < 70) return { kind: 'suspend', hours: 72, label: '72 giờ' };
  return { kind: 'none' };
}

export function clampPoints(value: number): number {
  return Math.max(0, Math.min(REPUTATION_START, Math.round(value)));
}

/** Later of the current suspension end and the new one: a fresh violation never shortens a ban. */
export function suspensionEnd(current: Date | null | undefined, hours: number, now: Date = new Date()): Date {
  const next = new Date(now.getTime() + hours * 3600_000);
  return current && current > next ? current : next;
}
