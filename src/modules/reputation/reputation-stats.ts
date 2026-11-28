import { REPUTATION_START } from './reputation-rules';

/**
 * Account states the Service Manager filters the reputation list by (BUG 318).
 * Each is read from the score and the ban columns the penalty rules write:
 *   deducted  -> score below 100 in the current period
 *   low       -> score below 70, the first suspension threshold
 *   suspended -> a booking ban (customer) or job ban (technician) still running, account not locked
 *   locked    -> account status locked
 */
export const REPUTATION_STATES = ['deducted', 'low', 'suspended', 'locked'] as const;
export type ReputationState = (typeof REPUTATION_STATES)[number];

export const REPUTATION_LOW_BELOW = 70;

/**
 * SQL predicates over users "u" left-joined to technician_profiles "tp", in
 * TypeORM property paths. The list filter and the counts share them so a card
 * and the rows it filters can never disagree.
 */
export const REPUTATION_STATE_WHERE: Record<ReputationState, string> = {
  deducted: `u.reputationPoints < ${REPUTATION_START}`,
  low: `u.reputationPoints < ${REPUTATION_LOW_BELOW}`,
  suspended: `u.status <> 'locked' AND ((u.role = 'customer' AND u.bookingSuspendedUntil > now()) OR (u.role = 'technician' AND tp.workSuspendedUntil > now()))`,
  locked: `u.status = 'locked'`,
};

export interface ReputationStats {
  /** Accounts by role, whatever filter is open: the counts of the role filter. */
  roles: { all: number; customer: number; technician: number };
  /** Accounts in the selected role (both when none). */
  total: number;
  deducted: number;
  low: number;
  suspended: number;
  locked: number;
}

/** PostgreSQL returns COUNT as a bigint string; a missing row counts as 0. */
export function toReputationStats(raw: Record<string, unknown> | null | undefined): ReputationStats {
  const n = (key: string) => {
    const value = Number(raw?.[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    roles: { all: n('all'), customer: n('customer'), technician: n('technician') },
    total: n('total'),
    deducted: n('deducted'),
    low: n('low'),
    suspended: n('suspended'),
    locked: n('locked'),
  };
}
