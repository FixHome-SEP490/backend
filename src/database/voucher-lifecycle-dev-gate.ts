/**
 * DEV-only release gate for the one new VoucherCampaignLifecycle migration.
 * Intended for the GitHub Actions VPS deploy job, inside the new Backend image.
 * Never receives arbitrary SQL/URLs and never logs database credentials.
 */
import 'reflect-metadata';
import dataSource from './data-source';

const EXPECTED = 'VoucherCampaignLifecycle1793116800000';
const PREREQUISITES = ['VoucherCore1792994400000', 'VoucherFundingLedger1792994400001'];

async function main() {
  if (process.env.NODE_ENV !== 'production' || process.env.VOUCHER_LIFECYCLE_DEV_RELEASE !== '1') {
    throw new Error('Voucher migration DEV gate requires production runtime and explicit release flag');
  }
  const db = await dataSource.initialize();
  try {
    const relation = await db.query("SELECT to_regclass('public.voucher_campaigns') AS campaign, to_regclass('public.migrations') AS ledger");
    if (!relation[0]?.campaign || !relation[0]?.ledger) throw new Error('Missing voucher core table or migration ledger');
    const appliedRows: Array<{ name: string }> = await db.query('SELECT name FROM public.migrations');
    const applied = new Set(appliedRows.map((row) => row.name));
    if (PREREQUISITES.some((name) => !applied.has(name))) throw new Error('Core/F4 migration prerequisites absent; never rerun historical migrations');
    if (!db.migrations.some((m) => m.name === EXPECTED)) throw new Error('Expected lifecycle migration not present in Backend image');

    // Prevent accidental application of a different pending release's schema changes.
    const pending = db.migrations.filter((m) => !applied.has(m.name)).map((m) => m.name);
    if (pending.length && (pending.length !== 1 || pending[0] !== EXPECTED)) {
      throw new Error('Unexpected pending database migrations; manual audit required before release');
    }
    const [role] = await db.query(`
      SELECT (c.relowner = r.oid) AS owns_table, r.rolsuper AS superuser,
             r.rolbypassrls AS bypass_rls,
             has_table_privilege(current_user, 'public.voucher_campaigns', 'SELECT') AS can_read
      FROM pg_class c JOIN pg_roles r ON r.rolname = current_user
      WHERE c.oid = 'public.voucher_campaigns'::regclass
    `);
    if (!role?.can_read || (!role?.owns_table && !role?.superuser)) {
      throw new Error('Runtime Backend DB role lacks owner/read privileges for this RLS-sensitive migration');
    }
    // The new schema enables RLS and explicitly revokes anon/authenticated/
    // service_role. A non-owner login may lose voucher access after the cutover.
    if (!role.owns_table && !role.bypass_rls && !role.superuser) {
      throw new Error('Application role would lose visibility when RLS is enabled');
    }

    if (pending.length) {
      const migrated = await db.runMigrations({ transaction: 'each' });
      if (migrated.length !== 1 || migrated[0]?.name !== EXPECTED) throw new Error('Unexpected migration execution outcome');
    }
    const [proof] = await db.query(`
      SELECT c.relrowsecurity AS rls_enabled,
             EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND tgname='voucher_campaign_immutable' AND NOT tgisinternal) AS guarded,
             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='voucher_campaigns' AND column_name='status') AS has_status,
             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='voucher_campaigns' AND column_name='version') AS has_version,
             EXISTS (SELECT 1 FROM public.migrations WHERE name='VoucherCampaignLifecycle1793116800000') AS applied
      FROM pg_class c WHERE c.oid='public.voucher_campaigns'::regclass
    `);
    if (!proof?.rls_enabled || !proof?.guarded || !proof?.has_status || !proof?.has_version || !proof?.applied) {
      throw new Error('Voucher migration proof incomplete; abort Backend restart');
    }
    console.info(pending.length ? 'Voucher lifecycle DEV migration applied and verified' : 'Voucher lifecycle DEV migration already applied and verified');
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Voucher DEV migration gate failed');
  process.exitCode = 1;
});
