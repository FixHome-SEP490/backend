import { describe, expect, it } from 'vitest';
import { explainEmptyCandidates } from './candidate-empty-reason';

const scenario = (overrides: Partial<Parameters<typeof explainEmptyCandidates>[0]> = {}) => ({
  results: 0, bookingHasCoordinates: true, skilledProfiles: 2,
  coverageRejected: 2, originUnknown: 0, eligibleForLocation: 0,
  eligibilityReasons: [] as string[], ...overrides,
});

describe('BUG #41 — conservative empty candidate diagnostics', () => {
  it('labels actual known coverage rejection, not a calendar problem', () =>
    expect(explainEmptyCandidates(scenario())).toBe('OUTSIDE_COVERAGE'));

  it('never presumes coverage when even one profile has unknown origin', () =>
    expect(explainEmptyCandidates(scenario({ originUnknown: 1, coverageRejected: 1 }))).toBe('UNAVAILABLE'));

  it('labels missing customer-confirmed coordinates before technician coverage', () =>
    expect(explainEmptyCandidates(scenario({ bookingHasCoordinates: false }))).toBe('BOOKING_LOCATION_MISSING'));

  it('does not claim no skill or no coverage from an empty available/verified profile pool', () =>
    expect(explainEmptyCandidates(scenario({ skilledProfiles: 0, coverageRejected: 0 }))).toBe('UNAVAILABLE'));

  it('labels schedule only if EVERY location-qualified profile failed for time reasons', () =>
    expect(explainEmptyCandidates(scenario({
      coverageRejected: 0, eligibleForLocation: 2,
      eligibilityReasons: ['Outside working schedule', 'Session already booked'],
    }))).toBe('TIME_UNAVAILABLE'));

  it('does not mislabel money, verification or mixed failures as time', () =>
    expect(explainEmptyCandidates(scenario({
      coverageRejected: 0, eligibleForLocation: 2,
      eligibilityReasons: ['Outside working schedule', 'Minimum wallet balance is required to accept new jobs'],
    }))).toBe('UNAVAILABLE'));

  it('does not disclose any reason when there is at least one eligible candidate', () =>
    expect(explainEmptyCandidates(scenario({ results: 1 }))).toBeNull());

  it('does not label time if eligibility produced incomplete diagnostics', () =>
    expect(explainEmptyCandidates(scenario({ coverageRejected: 0, eligibleForLocation: 2,
      eligibilityReasons: ['Session already booked'] }))).toBe('UNAVAILABLE'));
});
