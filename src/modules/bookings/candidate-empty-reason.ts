/** Public-facing, coarse reasons only. Never expose individual eligibility failures. */
export type CandidateEmptyReason =
  | 'BOOKING_LOCATION_MISSING'
  | 'OUTSIDE_COVERAGE'
  | 'TIME_UNAVAILABLE'
  | 'UNAVAILABLE';

const TIME_REASONS = new Set([
  'Booking time window is missing',
  'Booking time window is invalid or expired',
  'Outside working schedule',
  'Technician has time off',
  'Session already booked',
  'Assignment schedule conflict',
  'Technician is on another job',
  'Scheduled job in this session is not done',
]);

export interface CandidateAvailabilityFacts {
  results: number;
  bookingHasCoordinates: boolean;
  skilledProfiles: number;
  coverageRejected: number;
  originUnknown: number;
  eligibleForLocation: number;
  eligibilityReasons: string[];
}

/**
 * Never guess an address or time problem when other blockers could explain an empty list.
 * A technician whose origin is unknown (no work address, no fresh GPS) is never matched for any
 * address, so they do not block the coverage answer. At least one located technician must have
 * been refused for coverage and none accepted (bug 41: a few such profiles on the shared database
 * hid the out of area state for every Hà Nội booking).
 */
export function explainEmptyCandidates(facts: CandidateAvailabilityFacts): CandidateEmptyReason | null {
  if (facts.results > 0) return null;
  if (!facts.bookingHasCoordinates) return 'BOOKING_LOCATION_MISSING';
  if (facts.skilledProfiles > 0 && facts.eligibleForLocation === 0 &&
      facts.coverageRejected > 0 &&
      facts.coverageRejected + facts.originUnknown === facts.skilledProfiles) return 'OUTSIDE_COVERAGE';
  if (facts.eligibleForLocation > 0 &&
      facts.eligibilityReasons.length === facts.eligibleForLocation &&
      facts.eligibilityReasons.every((reason) => TIME_REASONS.has(reason))) return 'TIME_UNAVAILABLE';
  return 'UNAVAILABLE';
}
