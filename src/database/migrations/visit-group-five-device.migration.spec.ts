import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const migrationPath = resolve(__dirname, '1793379600001-VisitGroupDeviceLimitFive.ts');
const migrationName = 'VisitGroupDeviceLimitFive1793379600001';
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function loadMigration() {
  const source = readFileSync(migrationPath, 'utf8');
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 });
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(compiled, { module, exports: module.exports, require: createRequire(__filename) });
  return module.exports[migrationName] as new () => { up(queryRunner: unknown): Promise<void>; down(queryRunner: unknown): Promise<void> };
}

describe('VisitGroup five-device migration structure', () => {
  it('widens sequence and both rebook count checks while preserving solo rows', async () => {
    expect(existsSync(migrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;

    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => { statements.push(normalize(sql)); return []; });
    const Migration = loadMigration();
    await new Migration().up({ query });
    const sql = statements.join('\n');
    expect(statements).toHaveLength(6);
    expect(sql).toContain('ALTER TABLE "visit_group_items" DROP CONSTRAINT IF EXISTS "chk_visit_group_items_sequence"');
    expect(sql).toContain('ALTER TABLE "visit_group_items" ADD CONSTRAINT "chk_visit_group_items_sequence" CHECK ("sequence" BETWEEN 1 AND 5)');

    for (const [table, constraint] of [
      ['repair_failure_rebooks', 'chk_repair_failure_rebooks_count'],
      ['interruption_rebooks', 'chk_interruption_rebooks_count'],
    ]) {
      expect(sql).toContain(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`);
      expect(sql).toContain(`ADD CONSTRAINT "${constraint}" CHECK (("source_count" = 1 AND "target_visit_group_id" IS NULL) OR ("source_count" IN (2,3,4,5) AND "target_visit_group_id" IS NOT NULL))`);
    }

    const countChecks = [...sql.matchAll(/"source_count" IN \(([^)]+)\) AND "target_visit_group_id" IS NOT NULL/g)];
    expect(countChecks).toHaveLength(2);
    const groupCounts = countChecks.map(([, values]) => values.split(',').map(Number));
    const preservesSolo = /"source_count" = 1 AND "target_visit_group_id" IS NULL/.test(sql);
    const accepts = (sourceCount: number, targetVisitGroupId: string | null, allowed: number[]) =>
      (sourceCount === 1 && targetVisitGroupId === null && preservesSolo)
      || (targetVisitGroupId !== null && allowed.includes(sourceCount));
    for (const allowed of groupCounts) {
      expect(accepts(1, null, allowed)).toBe(true);
      expect(accepts(1, 'group-id', allowed)).toBe(false);
      expect(accepts(5, 'group-id', allowed)).toBe(true);
      expect(accepts(6, 'group-id', allowed)).toBe(false);
    }
    expect(sql).not.toMatch(/CREATE TABLE|DROP TABLE|DELETE FROM|\bUPDATE\b/i);
  });

  it('restores the original sequence and rebook checks on a safe down', async () => {
    expect(existsSync(migrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;

    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => { statements.push(normalize(sql)); return []; });
    const Migration = loadMigration();
    await new Migration().down({ query });
    const sql = statements.join('\n');
    expect(statements).toHaveLength(7);
    expect(statements[0]).toMatch(/^SELECT 1 WHERE/);
    expect(statements[0]).toContain('"sequence" > 3');
    expect(statements[0]).toContain('"repair_failure_rebooks" WHERE "target_visit_group_id" IS NOT NULL AND "source_count" > 3');
    expect(statements[0]).toContain('"interruption_rebooks" WHERE "target_visit_group_id" IS NOT NULL AND "source_count" > 3');
    expect(sql).toContain('ADD CONSTRAINT "chk_visit_group_items_sequence" CHECK ("sequence" BETWEEN 1 AND 3)');
    for (const [table, constraint] of [
      ['repair_failure_rebooks', 'chk_repair_failure_rebooks_count'],
      ['interruption_rebooks', 'chk_interruption_rebooks_count'],
    ]) {
      expect(sql).toContain(`ADD CONSTRAINT "${constraint}" CHECK (("source_count" = 1 AND "target_visit_group_id" IS NULL) OR ("source_count" IN (2,3) AND "target_visit_group_id" IS NOT NULL))`);
      expect(sql).toContain(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`);
    }
  });

  it.each([
    ['VisitGroup sequence 4', 'visit_group_items'], ['VisitGroup sequence 5', 'visit_group_items'],
    ['failed-repair group source_count 4', 'repair_failure_rebooks'], ['failed-repair group source_count 5', 'repair_failure_rebooks'],
    ['interruption group source_count 4', 'interruption_rebooks'], ['interruption group source_count 5', 'interruption_rebooks'],
  ])('refuses down for %s before making changes', async (_caseName, _table) => {
    expect(existsSync(migrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;

    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => { statements.push(normalize(sql)); return [{ conflict: true }]; });
    const Migration = loadMigration();
    await expect(new Migration().down({ query })).rejects.toThrow('Refusing to restore the three-device VisitGroup and rebook limits');
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^SELECT 1 WHERE/);
    expect(statements.join('\n')).not.toMatch(/ALTER TABLE|DROP CONSTRAINT|ADD CONSTRAINT/i);
  });
});
