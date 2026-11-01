import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveVisitGroupStatus, visitGroupStatusSql, type VisitGroupReadItemStatus } from '../src/modules/visit-groups/visit-group-read';

// SELECT-only fixtures: CTEs shadow all production tables. No migrations, DDL,
// seeds or application startup; refuse remote/shared database connections.
describe('VisitGroup historical status PostgreSQL projection', () => {
  let client: Client | undefined;
  beforeAll(async () => {
    const host = process.env.DATABASE_HOST || '127.0.0.1';
    if (!['127.0.0.1', 'localhost'].includes(host) || process.env.DATABASE_SSL === 'true') {
      throw new Error('Refusing projection test outside disposable localhost PostgreSQL');
    }
    client = new Client({ host, port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USER || 'postgres', password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'fixhome', connectionTimeoutMillis: 3000 });
    await client.connect();
  });
  afterAll(async () => { await client?.end(); });

  it.each([
    { statuses: ['under_repair', 'under_repair'], outcomes: [null, 'interrupted'], expected: 'under_repair' },
    { statuses: ['under_repair', 'en_route'], outcomes: ['interrupted', null], expected: 'en_route' },
    { statuses: ['under_repair', 'accepted'], outcomes: ['interrupted', null], expected: 'accepted' },
    { statuses: ['under_repair', 'en_route'], outcomes: ['interrupted', 'interrupted'], expected: 'mixed' },
    { statuses: ['completed', 'under_repair'], outcomes: ['succeeded', 'interrupted'], expected: 'mixed' },
    { statuses: ['completed', 'under_repair'], outcomes: [null, 'interrupted'], expected: 'mixed' },
    { statuses: ['completed', 'completed'], outcomes: [null, null], expected: 'completed' },
  ])('$statuses / $outcomes => $expected in TS and PostgreSQL', async ({ statuses, outcomes, expected }) => {
    const items: VisitGroupReadItemStatus[] = statuses.map((orderStatus, i) => ({
      orderStatus, outcome: outcomes[i], bookingStatus: 'matched', hasActiveAssignment: outcomes[i] == null,
    }));
    const parameters = items.flatMap((item, i) => [String(i), item.orderStatus, item.outcome, item.hasActiveAssignment]);
    const values = items.map((_, i) => {
      const n = i * 4;
      return `($${n + 1}::text, $${n + 2}::text, $${n + 3}::text, $${n + 4}::boolean)`;
    }).join(',');
    const result = await client!.query(`WITH
      fixture(id,status,outcome,is_active) AS (VALUES ${values}),
      visit_groups AS (SELECT 'group'::text AS id),
      visit_group_items AS (SELECT 'group'::text AS group_id, id AS booking_id, outcome FROM fixture),
      bookings AS (SELECT id, 'matched'::text AS status FROM fixture),
      service_orders AS (SELECT id, id AS booking_id, status FROM fixture),
      technician_assignments AS (SELECT id AS service_order_id, is_active FROM fixture)
      SELECT ${visitGroupStatusSql()} AS status FROM visit_groups vg`, parameters);
    expect(deriveVisitGroupStatus(items)).toBe(expected);
    expect(result.rows).toEqual([{ status: expected }]);
  });
});
