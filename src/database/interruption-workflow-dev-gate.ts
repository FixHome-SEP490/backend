/**
 * DEV-only, fail-closed release gate for the interruption workflow.
 * Uses the existing TypeORM migrations ledger and applies ONLY the one expected
 * new migration. Old voucher/parts/money migrations are never rerun.
 */
import 'reflect-metadata';
import dataSource from './data-source';

const EXPECTED = 'InterruptionWorkflow1793203200000';
const REQUIRED = [
  'VoucherCore1792994400000',
  'VoucherFundingLedger1792994400001',
  'VoucherCampaignLifecycle1793116800000',
];

async function main() {
  if (process.env.NODE_ENV !== 'production' || process.env.INTERRUPTION_WORKFLOW_DEV_RELEASE !== '1') {
    throw new Error('Interruption DEV migration requires production runtime and explicit release flag');
  }
  const db = await dataSource.initialize();
  try {
    const [role] = await db.query(
      "SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypassrls, " +
      "has_schema_privilege(current_user,'public','CREATE') AS can_create " +
      "FROM pg_roles r WHERE r.rolname=current_user",
    );
    if (!role?.can_create || (!role.superuser && !role.bypassrls)) {
      throw new Error('Backend database role is not authorized to perform protected DEV schema cutover');
    }
    const [base] = await db.query(
      "SELECT to_regclass('public.migrations') AS migrations, " +
      "to_regclass('public.support_cases') AS cases, " +
      "to_regclass('public.visit_group_items') AS items",
    );
    if (!base?.migrations || !base?.cases || !base?.items) {
      throw new Error('Interruption migration prerequisites missing');
    }
    const appliedRows: Array<{ name: string }> = await db.query('SELECT name FROM public.migrations');
    const applied = new Set(appliedRows.map(row => row.name));
    if (REQUIRED.some(name => !applied.has(name))) {
      throw new Error('Voucher Core/F4/lifecycle prerequisites missing: refuse historical rerun');
    }
    if (!db.migrations.some(m => m.name === EXPECTED)) throw new Error('Expected interruption migration missing in image');
    const pending = db.migrations.filter(m => !applied.has(m.name)).map(m => m.name);
    if (pending.length && (pending.length !== 1 || pending[0] !== EXPECTED)) {
      throw new Error('Unexpected pending migration(s), refusing DEV deploy');
    }
    if (pending.length) {
      const ran = await db.runMigrations({ transaction: 'each' });
      if (ran.length !== 1 || ran[0]?.name !== EXPECTED) throw new Error('Unexpected applied migration result');
    }
    const [proof] = await db.query(`
      SELECT
        EXISTS (SELECT 1 FROM public.migrations WHERE name='InterruptionWorkflow1793203200000') AS applied,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='support_cases' AND column_name='request_intent') AS intent,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='support_cases' AND column_name='workflow_version') AS version,
        to_regclass('public.interruption_rebooks') IS NOT NULL AS receipt,
        to_regclass('public.interruption_rebook_sources') IS NOT NULL AS sources,
        (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.interruption_rebooks')) AS receipt_rls,
        (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.interruption_rebook_sources')) AS sources_rls,
        EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid=to_regclass('public.visit_group_items') AND conname='chk_visit_group_items_outcome'
                  AND pg_get_constraintdef(oid) LIKE '%interrupted%') AS group_outcome
    `);
    if (!proof?.applied || !proof?.intent || !proof?.version || !proof?.receipt || !proof?.sources
        || !proof?.receipt_rls || !proof?.sources_rls || !proof?.group_outcome) {
      throw new Error('Interruption schema proof incomplete; do not restart Backend');
    }
    for (const table of ['interruption_rebooks', 'interruption_rebook_sources']) {
      const [access] = await db.query(`
        SELECT has_table_privilege('anon', $1, 'SELECT') AS anon_read,
               has_table_privilege('authenticated', $1, 'SELECT') AS auth_read,
               has_table_privilege('service_role', $1, 'SELECT') AS service_read
      `, [`public.${table}`]);
      if (access?.anon_read || access?.auth_read || access?.service_read) {
        throw new Error('Unexpected Data API access to private interruption records');
      }
    }
    console.info(pending.length ? 'Interruption workflow DEV migration applied and verified'
      : 'Interruption workflow DEV migration already applied and verified');
  } finally {
    await db.destroy();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Interruption DEV migration gate failed');
  process.exitCode = 1;
});
