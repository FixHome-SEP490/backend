import { describe, expect, it, vi } from 'vitest';
import { OtherServiceCatalog1790000000025 } from '../../src/database/migrations/1790000000025-OtherServiceCatalog';

describe('OtherServiceCatalog1790000000025', () => {
  it('upserts one active canonical Other category and service without fixed pricing', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new OtherServiceCatalog1790000000025().up(queryRunner);

    const sql = queries.join('\n').toLowerCase();
    expect(sql).toContain('"code", "slug"');
    expect(sql).toContain("'khac'");
    expect(sql).toContain("'dich_vu_khac'");
    expect(sql).toContain("'dich-vu-khac'");
    expect(sql).toContain("'inspection_required'");
    expect(sql).toContain("'yêu cầu'");
    expect(sql).toContain('0, null, null');
    expect(sql).toContain('on conflict ("code") do update');
    expect(sql).toContain('"is_active" = true');
  });

  it('revert deactivates the canonical rows instead of deleting historical references', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new OtherServiceCatalog1790000000025().down(queryRunner);

    const sql = queries.join('\n').toLowerCase();
    expect(sql).toContain('update "services"');
    expect(sql).toContain("'dich_vu_khac'");
    expect(sql).toContain('update "service_categories"');
    expect(sql).toContain("'khac'");
    expect(sql).toContain('"is_active" = false');
    expect(sql).not.toContain('delete from');
    expect(sql).not.toContain('cascade');
  });
});
