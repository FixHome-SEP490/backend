/** DEV-only forward migration gate. Historical migrations are never replayed. */
import 'reflect-metadata';
import { DataSource } from 'typeorm';

const REQUIRED = [
  'VoucherCore1792994400000', 'VoucherFundingLedger1792994400001',
  'VoucherCampaignLifecycle1793116800000', 'InterruptionWorkflow1793203200000',
];
const EXPECTED = ['CashPaymentIntents1793293200000', 'TechnicianResponsibility1793293200001'];

export function planCashReputationMigrations(appliedNames: string[], imageNames: string[]): string[] {
  const applied = new Set(appliedNames);
  if (REQUIRED.some(name => !applied.has(name))) throw new Error('Voucher/interruption migration prerequisites missing');
  if (EXPECTED.some(name => !imageNames.includes(name))) throw new Error('Cash/reputation migrations missing from image');
  if (applied.has(EXPECTED[1]) && !applied.has(EXPECTED[0])) throw new Error('Cash/reputation ledger order is invalid');
  const pending = imageNames.filter(name => !applied.has(name));
  const remaining = EXPECTED.filter(name => !applied.has(name));
  if (pending.length !== remaining.length || pending.some((name, index) => name !== remaining[index])) {
    throw new Error('Unexpected pending migration or order; refusing DEV deploy');
  }
  return pending;
}

async function verifyCashSchema(db: DataSource): Promise<void> {
  const [proof] = await db.query(`
    SELECT to_regclass('public.cash_payment_intents') IS NOT NULL AS cash_table,
      (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.cash_payment_intents')) AS cash_rls,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.cash_payment_intents')
        AND tgname='cash_intent_guard' AND tgenabled='O') AS cash_guard,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.cash_payment_intents')
        AND conname='chk_cash_intent_receipt') AS receipt_check,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='cash_payment_intents' AND column_name='allocation_snapshot') AS allocation_snapshot,
      EXISTS (SELECT 1 FROM public.migrations WHERE name='CashPaymentIntents1793293200000') AS applied
  `);
  if (!proof || Object.values(proof).some(value => value !== true)) {
    throw new Error('Cash intent schema proof incomplete; do not restart Backend');
  }
  for (const index of ['uq_cash_intent_customer_command', 'uq_cash_intent_pending_scope', 'uq_cash_intent_receipt_command']) {
    const [row] = await db.query(`SELECT i.indisunique AS unique_index, i.indisvalid AS valid_index
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.oid=to_regclass($1)`, [`public.${index}`]);
    if (!row?.unique_index || !row?.valid_index) throw new Error(`Cash intent unique index missing: ${index}`);
  }
  const [publicAcl] = await db.query(`SELECT EXISTS (
    SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid=to_regclass('public.cash_payment_intents') AND a.grantee=0
      AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')) AS exposed`);
  if (publicAcl?.exposed) throw new Error('PUBLIC has cash intent Data API access');
  const roles: Array<{ rolname: string }> = await db.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')",
  );
  for (const { rolname } of roles) {
    const [access] = await db.query(`SELECT
      has_table_privilege($1,'public.cash_payment_intents','SELECT') AS read,
      has_table_privilege($1,'public.cash_payment_intents','INSERT') AS insert,
      has_table_privilege($1,'public.cash_payment_intents','UPDATE') AS update,
      has_table_privilege($1,'public.cash_payment_intents','DELETE') AS delete`, [rolname]);
    if (Object.values(access ?? {}).some(Boolean)) throw new Error(`Data API role has cash intent access: ${rolname}`);
  }
  const [app] = await db.query(`SELECT
    has_table_privilege(current_user,'public.cash_payment_intents','SELECT') AS read,
    has_table_privilege(current_user,'public.cash_payment_intents','INSERT') AS insert,
    has_table_privilege(current_user,'public.cash_payment_intents','UPDATE') AS update`);
  if (!app?.read || !app?.insert || !app?.update) throw new Error('Backend role cannot use cash intent table');
}

async function verifyResponsibilitySchema(db: DataSource): Promise<void> {
  const columns = ['reason_class', 'reason_code', 'responsibility', 'responsibility_command_id',
    'responsibility_actor_id', 'responsibility_reason', 'responsibility_evidence_refs', 'responsibility_decided_at'];
  const rows: Array<{ column_name: string }> = await db.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='support_cases' AND column_name=ANY($1)`, [columns]);
  if (rows.length !== columns.length) throw new Error('Technician responsibility columns incomplete');
  const [proof] = await db.query(`SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='reputation_events' AND column_name='support_case_id') AS case_link,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.support_cases')
      AND conname='chk_technician_report_reason') AS reason_check,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.support_cases')
      AND conname='chk_technician_report_decision') AS decision_check,
    EXISTS (SELECT 1 FROM public.migrations WHERE name='TechnicianResponsibility1793293200001') AS applied`);
  if (!proof || Object.values(proof).some(value => value !== true)) throw new Error('Technician responsibility schema proof incomplete');
  for (const index of ['uq_pending_technician_report', 'uq_technician_responsibility_command', 'uq_reputation_case_event']) {
    const [row] = await db.query(`SELECT i.indisunique AS unique_index, i.indisvalid AS valid_index
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.oid=to_regclass($1)`, [`public.${index}`]);
    if (!row?.unique_index || !row?.valid_index) throw new Error(`Responsibility unique index missing: ${index}`);
  }
}

export async function runCashReputationDevGate(db: DataSource, cashFirstEnabled = false): Promise<string[]> {
  const lock = db.createQueryRunner();
  await lock.connect();
  let acquired = false;
  try {
    const [mutex] = await lock.query('SELECT pg_try_advisory_lock(1793293200, 1) AS acquired');
    if (!mutex?.acquired) throw new Error('Another cash/reputation migration gate is running');
    acquired = true;
    const [role] = await db.query(`SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
      has_schema_privilege(current_user,'public','CREATE') AS can_create,
      current_schema() AS active_schema FROM pg_roles r WHERE r.rolname=current_user`);
    if (role?.active_schema !== 'public' || !role?.can_create || (!role.superuser && !role.bypass_rls)) {
      throw new Error('Backend database role or schema is unsafe for protected DEV migration');
    }
    const [base] = await db.query(`SELECT to_regclass('public.migrations') AS ledger,
      to_regclass('public.support_cases') AS cases,
      to_regclass('public.reputation_events') AS reputation,
      to_regclass('public.voucher_campaigns') AS campaigns,
      to_regclass('public.voucher_reservations') AS reservations,
      to_regclass('public.voucher_payment_links') AS funding_links,
      to_regclass('public.interruption_rebooks') AS interruption_rebooks,
      to_regclass('public.cash_settlements') AS settlements,
      to_regclass('public.visit_group_payments') AS group_payments`);
    if (!base || Object.values(base).some(value => value === null)) throw new Error('Cash/reputation migration base tables missing');
    const [priorSchema] = await db.query(`SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='voucher_campaigns' AND column_name='status') AS voucher_lifecycle,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='support_cases' AND column_name='request_intent') AS interruption_case,
      (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.interruption_rebooks')) AS interruption_rls`);
    if (!priorSchema || Object.values(priorSchema).some(value => value !== true)) {
      throw new Error('Voucher/interruption prerequisite schema incomplete');
    }
    const rows: Array<{ name: string }> = await db.query('SELECT name FROM public.migrations');
    // TypeORM executes by the 13-digit migration timestamp, not glob order.
    const imageNames = [...db.migrations]
      .sort((left, right) => Number(left.name.slice(-13)) - Number(right.name.slice(-13)))
      .map(migration => migration.name);
    const pending = planCashReputationMigrations(rows.map(row => row.name), imageNames);
    if (cashFirstEnabled && pending.length) {
      throw new Error('Cash-first activation requires a completed schema-only DEV deploy first');
    }
    if (pending.length === 1 || pending.length === 0) await verifyCashSchema(db);
    if (pending.length) {
      const ran = await db.runMigrations({ transaction: 'each' });
      if (ran.length !== pending.length || ran.some((migration, index) => migration.name !== pending[index])) {
        throw new Error('Unexpected migration execution result; do not restart Backend');
      }
    }
    await verifyCashSchema(db);
    await verifyResponsibilitySchema(db);
    if (!cashFirstEnabled) {
      const [active] = await db.query("SELECT EXISTS (SELECT 1 FROM public.cash_payment_intents WHERE status='pending') AS pending");
      if (active?.pending) throw new Error('Pending cash-first intents exist; refusing legacy-mode Backend restart');
    }
    return pending;
  } finally {
    if (acquired) await lock.query('SELECT pg_advisory_unlock(1793293200, 1)');
    await lock.release();
  }
}
