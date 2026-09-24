import { isUUID } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { seedUsers } from '../../src/database/seeds/seed-users';

type QueryCall = [sql: string, parameters: unknown[]];

function createHarness() {
  const calls: QueryCall[] = [];
  const userIdByEmail = new Map<string, string>();
  const profileIdByUserId = new Map<string, string>();
  const queryRunner = {
    connect: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(async (sql: string, parameters: unknown[] = []) => {
      calls.push([sql, parameters]);
      if (sql.includes('INSERT INTO "users"')) {
        userIdByEmail.set(String(parameters[1]), String(parameters[0]));
      } else if (sql.includes('INSERT INTO "technician_profiles"')) {
        profileIdByUserId.set(String(parameters[1]), String(parameters[0]));
      } else if (sql.includes('SELECT "id" FROM "users" WHERE "email"')) {
        return [{ id: userIdByEmail.get(String(parameters[0])) }];
      } else if (sql.includes('SELECT "id" FROM "technician_profiles" WHERE "user_id"')) {
        return [{ id: profileIdByUserId.get(String(parameters[0])) }];
      }
      return [];
    }),
  };
  const dataSource = {
    createQueryRunner: vi.fn(() => queryRunner),
  };

  return { calls, dataSource };
}

function extractFirstValue(sql: string): string {
  const match = sql.match(/VALUES \('([^']+)'/);
  if (!match)
    throw new Error(`Could not extract inline seed id from SQL: ${sql}`);
  return match[1];
}

function getSeedIds(
  calls: QueryCall[],
  table: 'users' | 'technician_profiles',
) {
  return calls
    .filter(([sql]) => sql.includes(`INSERT INTO "${table}"`))
    .map(([sql, parameters]) =>
      table === 'users' && sql.includes("VALUES ('")
        ? extractFirstValue(sql)
        : String(parameters[0]),
    );
}

describe('seedUsers demo UUIDs', () => {
  it('generates deterministic, unique UUID v4 ids for users and technician profiles', async () => {
    const first = createHarness();
    const second = createHarness();

    await seedUsers(first.dataSource as never);
    await seedUsers(second.dataSource as never);

    const firstUserIds = getSeedIds(first.calls, 'users');
    const firstProfileIds = getSeedIds(first.calls, 'technician_profiles');
    const secondIds = [
      ...getSeedIds(second.calls, 'users'),
      ...getSeedIds(second.calls, 'technician_profiles'),
    ];
    const allIds = [...firstUserIds, ...firstProfileIds];

    expect(firstUserIds).toHaveLength(23);
    expect(firstProfileIds).toHaveLength(12);
    expect(allIds).toEqual(secondIds);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.every((id) => isUUID(id))).toBe(true);
    expect(allIds.every((id) => isUUID(id, '4'))).toBe(true);
  });

  it('uses the generated ids consistently in seed foreign-key parameters', async () => {
    const harness = createHarness();
    await seedUsers(harness.dataSource as never);

    const userIds = new Set(getSeedIds(harness.calls, 'users'));
    const profileIds = new Set(
      getSeedIds(harness.calls, 'technician_profiles'),
    );
    const callsFor = (table: string) =>
      harness.calls.filter(([sql]) => sql.includes(`INSERT INTO "${table}"`));

    expect(
      callsFor('user_scopes').every(([, parameters]) =>
        userIds.has(String(parameters[0])),
      ),
    ).toBe(true);
    expect(
      callsFor('technician_profiles').every(([, parameters]) =>
        userIds.has(String(parameters[1])),
      ),
    ).toBe(true);
    expect(
      callsFor('technician_schedules').every(([, parameters]) =>
        profileIds.has(String(parameters[0])),
      ),
    ).toBe(true);
    expect(
      callsFor('technician_service_areas').every(([, parameters]) =>
        profileIds.has(String(parameters[0])),
      ),
    ).toBe(true);
    expect(
      callsFor('addresses').every(([, parameters]) =>
        userIds.has(String(parameters[0])),
      ),
    ).toBe(true);
  });
});
