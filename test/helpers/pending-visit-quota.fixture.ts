import { vi } from 'vitest';

/** Add the new quota persistence boundary to pre-existing service doubles, with no pending visits.
 * Quota/race behavior itself is covered by booking-pending-quota.spec.ts, without this stub.
 */
export function stubPendingVisitQuota(manager: object): void {
  const target = manager as { query?: (...args: any[]) => any; queryRunner?: unknown };
  const original = target.query;
  target.queryRunner = { isTransactionActive: true };
  target.query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === 'SELECT id FROM users WHERE id = $1 FOR UPDATE') return [{ id: params?.[0] }];
    if (sql.includes('COUNT(DISTINCT COALESCE(b.visit_group_id, b.id))')) return [{ pending: 0 }];
    return original ? original.call(manager, sql, params) : [];
  });
}
