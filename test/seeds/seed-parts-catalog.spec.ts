import { describe, expect, it, vi } from 'vitest';
import {
  DEMO_PART_CATALOG,
  seedPartsCatalog,
} from '../../src/database/seeds/seed-parts-catalog';

type StoredPart = {
  id: string;
  sku: string;
  name: string;
  sellingPrice: number;
  warrantyDays: number;
  isActive: boolean;
};

const FORBIDDEN_INVENTORY_FIELDS = [
  'stock',
  'warehouse',
  'supplier',
  'purchase_order',
  'inventory',
  'reorder',
  'bin',
];

function createHarness(initial: StoredPart[] = [], failOnInsert = false) {
  const rows = initial.map((row) => ({ ...row }));
  const queryRunners: any[] = [];
  const dataSource = {
    createQueryRunner: vi.fn(() => {
      const queryRunner: any = {
        isTransactionActive: false,
        connect: vi.fn().mockResolvedValue(undefined),
        startTransaction: vi.fn().mockImplementation(async () => {
          queryRunner.isTransactionActive = true;
        }),
        commitTransaction: vi.fn().mockImplementation(async () => {
          queryRunner.isTransactionActive = false;
        }),
        rollbackTransaction: vi.fn().mockImplementation(async () => {
          queryRunner.isTransactionActive = false;
        }),
        release: vi.fn().mockResolvedValue(undefined),
        query: vi.fn(async (sql: string, parameters: unknown[] = []) => {
          const statement = sql.replace(/\s+/g, ' ').trim().toUpperCase();

          if (statement.startsWith('SELECT')) {
            return rows
              .filter((row) => row.sku === parameters[0])
              .map((row) => ({ id: row.id }));
          }

          if (statement.startsWith('INSERT')) {
            if (failOnInsert) throw new Error('insert failed');
            const [sku, name, sellingPrice, warrantyDays, isActive] =
              parameters as [string, string, number, number, boolean];
            rows.push({
              id: `part-${rows.length + 1}`,
              sku,
              name,
              sellingPrice,
              warrantyDays,
              isActive,
            });
            return [];
          }

          if (statement.startsWith('UPDATE')) {
            const [name, sellingPrice, warrantyDays, isActive, sku] =
              parameters as [string, number, number, boolean, string];
            const row = rows.find((candidate) => candidate.sku === sku);
            if (row) Object.assign(row, { name, sellingPrice, warrantyDays, isActive });
            return [];
          }

          throw new Error(`Unexpected SQL: ${sql}`);
        }),
      };
      queryRunners.push(queryRunner);
      return queryRunner;
    }),
  } as any;

  return { dataSource, rows, queryRunners };
}

function allCalls(harness: ReturnType<typeof createHarness>) {
  return harness.queryRunners.flatMap((queryRunner) => queryRunner.query.mock.calls);
}

describe('seedPartsCatalog', () => {
  it('inserts the active Board X fixture with only catalog fields', async () => {
    const harness = createHarness();

    await seedPartsCatalog(harness.dataSource);

    expect(harness.rows).toEqual([
      { id: 'part-1', ...DEMO_PART_CATALOG },
    ]);
    const calls = allCalls(harness);
    const insertCall = calls.find(([sql]) => sql.includes('INSERT'));
    expect(insertCall?.[1]).toEqual([
      DEMO_PART_CATALOG.sku,
      DEMO_PART_CATALOG.name,
      DEMO_PART_CATALOG.sellingPrice,
      DEMO_PART_CATALOG.warrantyDays,
      DEMO_PART_CATALOG.isActive,
    ]);
    const sql = calls.map(([statement]) => statement.toLowerCase()).join('\n');
    for (const field of FORBIDDEN_INVENTORY_FIELDS) {
      expect(sql).not.toContain(field);
    }

    const queryRunner = harness.queryRunners[0];
    expect(queryRunner.connect).toHaveBeenCalledOnce();
    expect(queryRunner.startTransaction).toHaveBeenCalledOnce();
    expect(queryRunner.commitTransaction).toHaveBeenCalledOnce();
    expect(queryRunner.release).toHaveBeenCalledOnce();
  });

  it('reruns without duplication and updates the existing row by SKU', async () => {
    const harness = createHarness();

    await seedPartsCatalog(harness.dataSource);
    Object.assign(harness.rows[0], {
      name: 'Stale Board',
      sellingPrice: 1,
      warrantyDays: 0,
      isActive: false,
    });
    await seedPartsCatalog(harness.dataSource);

    expect(harness.rows).toHaveLength(1);
    expect(harness.rows[0]).toMatchObject(DEMO_PART_CATALOG);
    const calls = allCalls(harness);
    expect(calls.filter(([sql]) => sql.includes('INSERT'))).toHaveLength(1);
    expect(calls.filter(([sql]) => sql.includes('UPDATE'))).toHaveLength(1);
    expect(calls.filter(([sql]) => sql.includes('WHERE "sku" = $1'))).toHaveLength(2);
    expect(
      calls.filter(
        ([sql]) => sql.includes('UPDATE') && sql.includes('WHERE "sku" = $5'),
      ),
    ).toHaveLength(1);
    const updateCall = calls.find(([sql]) => sql.includes('UPDATE'));
    expect(updateCall?.[1]).toEqual([
      DEMO_PART_CATALOG.name,
      DEMO_PART_CATALOG.sellingPrice,
      DEMO_PART_CATALOG.warrantyDays,
      DEMO_PART_CATALOG.isActive,
      DEMO_PART_CATALOG.sku,
    ]);
  });

  it('preserves unrelated parts and never issues delete SQL', async () => {
    const unrelated: StoredPart = {
      id: 'part-unrelated',
      sku: 'FH-OTHER',
      name: 'Other Part',
      sellingPrice: 123000,
      warrantyDays: 30,
      isActive: true,
    };
    const harness = createHarness([unrelated]);

    await seedPartsCatalog(harness.dataSource);

    expect(harness.rows).toHaveLength(2);
    expect(harness.rows.find((row) => row.sku === unrelated.sku)).toEqual(unrelated);
    expect(allCalls(harness).every(([sql]) => !sql.toUpperCase().includes('DELETE'))).toBe(true);
  });

  it('rolls back and releases the query runner when the write fails', async () => {
    const harness = createHarness([], true);

    await expect(seedPartsCatalog(harness.dataSource)).rejects.toThrow('insert failed');

    const queryRunner = harness.queryRunners[0];
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledOnce();
    expect(queryRunner.release).toHaveBeenCalledOnce();
  });
});
