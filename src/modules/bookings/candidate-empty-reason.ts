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

/** Never guess an address or time problem when other blockers could explain an empty list. */
export function explainEmptyCandidates(facts: CandidateAvailabilityFacts): CandidateEmptyReason | null {
  if (facts.results > 0) return null;
  if (!facts.bookingHasCoordinates) return 'BOOKING_LOCATION_MISSING';
  if (facts.skilledProfiles > 0 && facts.eligibleForLocation === 0 &&
      facts.coverageRejected > 0 && facts.originUnknown === 0 &&
      facts.coverageRejected === facts.skilledProfiles) return 'OUTSIDE_COVERAGE';
  if (facts.eligibleForLocation > 0 &&
      facts.eligibilityReasons.length === facts.eligibleForLocation &&
      facts.eligibilityReasons.every((reason) => TIME_REASONS.has(reason))) return 'TIME_UNAVAILABLE';
  return 'UNAVAILABLE';
}
