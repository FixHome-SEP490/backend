import { describe, expect, it, vi } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { VoucherCampaignLifecycle1793116800000 } from '../../database/migrations/1793116800000-VoucherCampaignLifecycle';

// DDL contract only. SQL execution, RLS and locks require the opt-in PostgreSQL suite.
describe('campaign additive migration DDL contract (not PostgreSQL proof)', () => {
  it('backfills historical active/inactive as published/paused without changing voucher history or the generic F3 guard', async () => {
    const query = vi.fn(async (_sql: string) => undefined);
    await new VoucherCampaignLifecycle1793116800000().up({ query } as unknown as QueryRunner);
    const ddl = query.mock.calls.map(([sql]) => sql).join('\n');
    expect(ddl).toContain("CASE WHEN active THEN 'PUBLISHED' ELSE 'PAUSED' END");
    expect(ddl).toContain('published_at = created_at');
    expect(ddl).toContain('CREATE FUNCTION public.voucher_campaign_guard_write()');
    expect(ddl).toContain('EXECUTE FUNCTION public.voucher_campaign_guard_write()');
    expect(ddl).toContain("OLD.status = 'DRAFT' AND NEW.status = 'DRAFT'");
    expect(ddl).not.toMatch(/(?:CREATE OR REPLACE|DROP) FUNCTION (?:public\.)?voucher_guard_write/);
    expect(ddl).not.toMatch(/(?:UPDATE|DELETE FROM) public\.voucher_(?:claims|reservations|funding_entries|payment_links)/);
    expect(ddl).not.toMatch(/DISABLE TRIGGER/);
    expect(ddl).toContain('ENABLE ROW LEVEL SECURITY');
    expect(ddl).toContain('REVOKE ALL ON public.voucher_campaigns FROM PUBLIC');
  });
  it('refuses automatic rollback because it would lose draft/publication provenance', async () => {
    const query = vi.fn();
    await expect(new VoucherCampaignLifecycle1793116800000().down({ query } as unknown as QueryRunner)).rejects.toThrow('forward');
    expect(query).not.toHaveBeenCalled();
  });
});
