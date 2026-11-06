/** DEV-only forward migration gate for the W3 warehouse delivery slice.
 * Historical migrations are never replayed and no migration is ever downgraded. */
import 'reflect-metadata';
import { DataSource, MigrationInterface } from 'typeorm';

export const W3_MIGRATIONS = [
  'WarehouseDeliverySplit1793466000004',
  'DeliveryConsentState1793466000005',
  'W3DeliveryOperatingPolicy1793466000006',
  'WarehouseDeliveryPhysical1793466000007',
  'DeliveryZeroFeeOperations1793466000008',
  'W3DeliveryPolicyLifecycle1793466000009',
  'DeliveryConditionalFeeTerms1793466000010',
  'W3PrequoteCommission1793466000011',
] as const;

const FINANCE_PREREQUISITES = [
  'VoucherCore1792994400000',
  'VoucherFundingLedger1792994400001',
  'VoucherCampaignLifecycle1793116800000',
  'InterruptionWorkflow1793203200000',
] as const;

const WAREHOUSE_PREREQUISITES = [
  'WarehouseInventory1793379600003',
  'WarehousePartFulfillment1793466000003',
] as const;

export const W3_PREREQUISITES = [
  ...FINANCE_PREREQUISITES,
  ...WAREHOUSE_PREREQUISITES,
] as const;

/** The unchanged cash/reputation gate owns these; the W3 gate only leaves them pending. */
export const CASH_MIGRATIONS = [
  'CashPaymentIntents1793293200000',
  'TechnicianResponsibility1793293200001',
] as const;

const W3_SET = new Set<string>(W3_MIGRATIONS);
const CASH_SET = new Set<string>(CASH_MIGRATIONS);
const ALLOWED_PENDING = new Set<string>([...W3_MIGRATIONS, ...CASH_MIGRATIONS]);

const LOCK_NAMESPACE = 1793466000;
/** Distinct from the W3 policy write lock (namespace 1793466000, key 6). */
const LOCK_KEY = 4;

interface TablePrivilege {
  table: string;
  privileges: Array<'SELECT' | 'INSERT' | 'UPDATE'>;
}

const REQUIRED_APP_PRIVILEGES: TablePrivilege[] = [
  { table: 'w3_order_commission_snapshots', privileges: ['SELECT'] },
  { table: 'w3_commission_config_versions', privileges: ['SELECT'] },
  { table: 'delivery_fee_terms', privileges: ['SELECT', 'INSERT'] },
  {
    table: 'delivery_consent_sessions',
    privileges: ['SELECT', 'INSERT', 'UPDATE'],
  },
  { table: 'delivery_consent_commands', privileges: ['SELECT', 'INSERT'] },
  { table: 'delivery_evidence_records', privileges: ['SELECT', 'INSERT'] },
  { table: 'w3_delivery_policy_versions', privileges: ['SELECT', 'INSERT'] },
  { table: 'w3_delivery_policy_previews', privileges: ['SELECT', 'INSERT'] },
  { table: 'warehouse_delivery_gate', privileges: ['SELECT'] },
  { table: 'warehouse_delivery_cohorts', privileges: ['SELECT', 'INSERT'] },
  { table: 'warehouse_delivery_events', privileges: ['SELECT', 'INSERT'] },
  { table: 'warehouse_delivery_movements', privileges: ['SELECT'] },
  {
    table: 'delivery_operation_evidence',
    privileges: ['SELECT', 'INSERT'],
  },
  {
    table: 'delivery_shipping_proposals',
    privileges: ['SELECT', 'INSERT'],
  },
];

function migrationTimestamp(name: string): number {
  const timestamp = Number(name.slice(-13));
  if (!Number.isSafeInteger(timestamp))
    throw new Error('Invalid migration name in ledger or image');
  return timestamp;
}

/**
 * Returns only the W3 migrations that may be applied now. Any other pending
 * migration is a release blocker, except the exact cash/reputation pair that
 * the existing, unchanged cash gate applies immediately afterwards.
 */
export function planW3DevMigrations(
  appliedNames: string[],
  imageNames: string[],
): string[] {
  const applied = new Set(appliedNames);

  const imageW3 = imageNames.filter((name) => W3_SET.has(name));
  if (
    imageW3.length !== W3_MIGRATIONS.length ||
    imageW3.some((name, index) => name !== W3_MIGRATIONS[index])
  ) {
    throw new Error('W3 migrations missing from image or out of order');
  }
  const imageCash = imageNames.filter((name) => CASH_SET.has(name));
  if (
    imageCash.length !== CASH_MIGRATIONS.length ||
    imageCash.some((name, index) => name !== CASH_MIGRATIONS[index])
  ) {
    throw new Error(
      'Cash/reputation migrations missing from image or out of order',
    );
  }

  if (FINANCE_PREREQUISITES.some((name) => !applied.has(name))) {
    throw new Error('Voucher/interruption migration prerequisites missing');
  }
  if (WAREHOUSE_PREREQUISITES.some((name) => !applied.has(name))) {
    throw new Error('W1/W2 warehouse migration prerequisites missing');
  }

  const appliedW3 = W3_MIGRATIONS.filter((name) => applied.has(name));
  const expectedAppliedW3 = W3_MIGRATIONS.slice(0, appliedW3.length);
  if (appliedW3.some((name, index) => name !== expectedAppliedW3[index])) {
    throw new Error('W3 migration ledger order is invalid');
  }
  if (applied.has(CASH_MIGRATIONS[1]) && !applied.has(CASH_MIGRATIONS[0])) {
    throw new Error('Cash/reputation ledger order is invalid');
  }

  const pending = imageNames.filter((name) => !applied.has(name));
  if (pending.some((name) => !ALLOWED_PENDING.has(name))) {
    throw new Error(
      'Unexpected pending migration or order; refusing W3 DEV deploy',
    );
  }

  const pendingW3 = pending.filter((name) => W3_SET.has(name));
  const expectedPendingW3 = W3_MIGRATIONS.filter((name) => !applied.has(name));
  if (
    pendingW3.length !== expectedPendingW3.length ||
    pendingW3.some((name, index) => name !== expectedPendingW3[index])
  ) {
    throw new Error('Unexpected W3 migration order; refusing DEV deploy');
  }
  return pendingW3;
}

async function assertSafeRole(db: DataSource): Promise<void> {
  const [role] =
    await db.query(`SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
    has_schema_privilege(current_user,'public','CREATE') AS can_create,
    current_schema() AS active_schema FROM pg_roles r WHERE r.rolname=current_user`);
  if (
    !role ||
    role.active_schema !== 'public' ||
    !role.can_create ||
    (!role.superuser && !role.bypass_rls)
  ) {
    throw new Error(
      'Backend database role or schema is unsafe for protected W3 DEV migration',
    );
  }
}

async function assertPrerequisiteSchema(db: DataSource): Promise<void> {
  const [base] = await db.query(`SELECT
    to_regclass('public.migrations') AS migrations_ledger,
    to_regclass('public.invoices') AS invoices,
    to_regclass('public.part_requests') AS part_requests,
    to_regclass('public.service_orders') AS service_orders,
    to_regclass('public.users') AS users,
    to_regclass('public.technician_assignments') AS technician_assignments,
    to_regclass('public.warehouses') AS warehouses,
    to_regclass('public.quotations') AS quotations,
    to_regclass('public.additional_cost_requests') AS additional_cost_requests,
    to_regclass('public.bookings') AS bookings,
    to_regclass('public.fixhome_parts') AS fixhome_parts,
    to_regclass('public.audit_logs') AS audit_logs,
    to_regclass('public.roles') AS roles,
    to_regclass('public.permissions') AS permissions,
    to_regclass('public.role_permissions') AS role_permissions,
    to_regclass('public.voucher_campaigns') AS voucher_campaigns,
    to_regclass('public.support_cases') AS support_cases,
    to_regclass('public.interruption_rebooks') AS interruption_rebooks,
    to_regclass('public.warehouse_stock') AS warehouse_stock,
    to_regclass('public.stock_movements') AS stock_movements,
    to_regclass('public.part_request_warehouse_allocations') AS warehouse_allocations,
    to_regclass('public.warehouse_fulfillment_commands') AS fulfillment_commands,
    to_regclass('public.warehouse_fulfillment_movements') AS fulfillment_movements,
    to_regclass('public.part_request_items') AS part_request_items,
    to_regclass('public.additional_cost_items') AS additional_cost_items`);
  if (!base || Object.values(base).some((value) => value === null)) {
    throw new Error('W3 prerequisite base tables missing');
  }

  const [financeSource] = await db.query(`SELECT
    to_regclass('public.system_configs') IS NOT NULL AS config,
    to_regclass('public.quotation_items') IS NOT NULL AS quotation_items,
    (SELECT count(*)=20 FROM information_schema.columns WHERE table_schema='public' AND
      ((table_name='system_configs' AND column_name IN ('key','value','value_type','updated_at','updated_by_user_id'))
      OR (table_name='bookings' AND column_name IN ('pricing_mode_snapshot','fixed_unit_price_snapshot','quantity','scope_snapshot'))
      OR (table_name='quotation_items' AND column_name IN ('quotation_id','type','description','quantity','unit_price','line_total'))
      OR (table_name='additional_cost_items' AND column_name IN ('description','unit_price','line_total'))
      OR (table_name='additional_cost_requests' AND column_name IN ('supersedes_id','total_labor_delta')))) AS columns`);
  if (!financeSource || Object.values(financeSource).some((v) => v !== true))
    throw new Error('W3 prequote commission prerequisite source incomplete');
  const [prior] = await db.query(`SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='voucher_campaigns' AND column_name='status') AS voucher_lifecycle,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='support_cases' AND column_name='request_intent') AS interruption_case,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.interruption_rebooks')) AS interruption_rls,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='invoices' AND column_name='shipping_fee') AS invoice_shipping_fee,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='part_requests' AND column_name='fulfillment_method') AS fulfillment_method,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='part_requests' AND column_name='quotation_id') AS part_quotation,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='part_requests' AND column_name='additional_cost_id') AS part_additional_cost,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='service_orders' AND column_name='completion_requested_at') AS completion_requested,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='technician_assignments' AND column_name='is_active') AS assignment_active,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='quotations' AND column_name='version') AS quotation_version,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='bookings' AND column_name='customer_id') AS booking_customer,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.stock_movements')
      AND tgname='protect_stock_movements' AND tgenabled='O') AS stock_guard,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.part_request_warehouse_allocations')) AS allocation_rls,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.warehouse_fulfillment_commands')) AS command_rls,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.warehouse_fulfillment_movements')) AS movement_rls,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.warehouse_fulfillment_commands')
      AND tgname='protect_warehouse_fulfillment_commands' AND tgenabled='O') AS command_guard,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.warehouse_fulfillment_movements')
      AND tgname='protect_warehouse_fulfillment_movements' AND tgenabled='O') AS movement_guard,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='part_requests' AND column_name='shipping_fee') AS part_shipping_fee,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='warehouses' AND column_name='status') AS warehouse_status,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='warehouses' AND column_name='responsible_user_id') AS warehouse_responsible,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='additional_cost_requests' AND column_name='shipping_fee') AS additional_shipping_fee,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='additional_cost_requests' AND column_name='fulfillment_method') AS additional_fulfillment_method,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='warehouse_stock' AND column_name='updated_at') AS stock_updated_at,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='part_request_items' AND column_name='part_source') AS item_source,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='part_request_items' AND column_name='part_catalog_id') AS item_catalog,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='part_request_items' AND column_name='quantity') AS item_quantity,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='additional_cost_items' AND column_name='request_id') AS additional_item_request,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='additional_cost_items' AND column_name='type') AS additional_item_type,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='additional_cost_items' AND column_name='part_source') AS additional_item_source,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='additional_cost_items' AND column_name='part_catalog_id') AS additional_item_catalog,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='additional_cost_items' AND column_name='quantity') AS additional_item_quantity`);
  if (!prior || Object.values(prior).some((value) => value !== true)) {
    throw new Error(
      'W3 prerequisite schema incomplete; do not restart Backend',
    );
  }
}

function imageMigrationNames(db: DataSource): string[] {
  // TypeORM executes by the 13-digit migration timestamp, not glob order.
  return [...db.migrations]
    .sort(
      (left, right) =>
        migrationTimestamp(left.name) - migrationTimestamp(right.name),
    )
    .map((migration) => migration.name);
}

const W3_MARKERS: Record<string, string> = {
  [W3_MIGRATIONS[7]]: `SELECT (to_regclass('public.w3_order_commission_snapshots') IS NOT NULL
    OR to_regclass('public.w3_commission_config_versions') IS NOT NULL
    OR to_regprocedure('public.w3_prequote_commission_guard()') IS NOT NULL
    OR to_regprocedure('public.w3_approved_labor_source(uuid)') IS NOT NULL
    OR to_regprocedure('public.w3_prequote_commission_current(uuid)') IS NOT NULL
    OR to_regprocedure('public.w3_commission_config_capture()') IS NOT NULL
    OR to_regprocedure('public.w3_commission_config_snapshot()') IS NOT NULL
    OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='delivery_fee_terms' AND column_name='commission_order_id')) AS present`,
  [W3_MIGRATIONS[6]]: `SELECT (to_regclass('public.delivery_fee_terms') IS NOT NULL
    OR to_regclass('public.ix_delivery_fee_terms_order') IS NOT NULL
    OR to_regprocedure('public.w3_fee_terms_guard()') IS NOT NULL
    OR to_regprocedure('public.w3_fee_source_snapshot(uuid)') IS NOT NULL
    OR to_regprocedure('public.w3_fee_terms_complete()') IS NOT NULL
    OR to_regprocedure('public.w3_fee_audit_protect()') IS NOT NULL
    OR to_regclass('public.ux_w3_fee_terms_audit') IS NOT NULL
    OR to_regprocedure('public.w3_live_evidence_guard_0008()') IS NOT NULL) AS present`,
  [W3_MIGRATIONS[5]]: `SELECT (
    to_regclass('public.w3_delivery_policy_previews') IS NOT NULL
    OR to_regclass('public.uq_w3_delivery_policy_draft_content') IS NOT NULL
    OR to_regprocedure('public.w3_delivery_policy_insert_guard_draft_v1()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='w3_delivery_policy_versions' AND column_name='activation_preview_id')
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.audit_logs')
      AND tgname='w3_policy_audit_immutable')) AS present`,
  [W3_MIGRATIONS[0]]: `SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='invoices'
      AND column_name='shipping_policy_version') AS present`,
  [W3_MIGRATIONS[1]]: `SELECT to_regclass('public.delivery_consent_sessions') IS NOT NULL AS present`,
  [W3_MIGRATIONS[2]]: `SELECT to_regclass('public.w3_delivery_policy_versions') IS NOT NULL AS present`,
  [W3_MIGRATIONS[3]]: `SELECT to_regclass('public.warehouse_delivery_gate') IS NOT NULL AS present`,
  [W3_MIGRATIONS[4]]: `SELECT (
    to_regclass('public.delivery_operation_evidence') IS NOT NULL
    OR to_regclass('public.delivery_shipping_proposals') IS NOT NULL
    OR to_regprocedure('public.w3_live_quantities(uuid)') IS NOT NULL
    OR to_regprocedure('public.w3_live_source(uuid,uuid,uuid,uuid)') IS NOT NULL
    OR to_regprocedure('public.w3_live_evidence_guard()') IS NOT NULL
    OR to_regprocedure('public.w3_live_proposal_guard()') IS NOT NULL
    OR to_regprocedure('public.guard_w3_delivery_event_closed()') IS NOT NULL
    OR to_regprocedure('public.guard_w3_delivery_movement_closed()') IS NOT NULL
    OR to_regprocedure('public.w3_live_event_complete()') IS NOT NULL
    OR to_regprocedure('public.w3_live_request_guard()') IS NOT NULL
    OR to_regprocedure('public.w3_live_item_guard()') IS NOT NULL
    OR to_regprocedure('public.w3_live_invoice_guard()') IS NOT NULL
    OR to_regprocedure('public.w3_live_order_guard()') IS NOT NULL
    OR to_regprocedure('public.w3_live_assignment_guard()') IS NOT NULL
    OR to_regprocedure('public.w3_live_source_guard()') IS NOT NULL
    OR to_regprocedure('public.w3_live_warehouse_guard()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass('public.warehouse_delivery_events')
        AND tgname='w3_live_event_complete')
    OR EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass('public.part_requests')
        AND tgname='w3_live_request_guard')
    OR EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass('public.part_request_items')
        AND tgname='w3_live_item_guard')
    OR EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass('public.invoices')
        AND tgname='w3_live_invoice_guard')
    OR EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass('public.service_orders')
        AND tgname='w3_live_order_guard')
    OR EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass('public.technician_assignments')
        AND tgname='w3_live_assignment_guard')
    OR EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass('public.additional_cost_requests')
        AND tgname='w3_live_source_guard')
    OR EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass('public.additional_cost_items')
        AND tgname='w3_live_source_items_guard')
    OR EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass('public.warehouses')
        AND tgname='w3_live_warehouse_guard')
  ) AS present`,
};

async function assertNoReplay(
  db: DataSource,
  pending: string[],
): Promise<void> {
  for (const name of pending) {
    const [row] = await db.query(W3_MARKERS[name]);
    if (row?.present) {
      throw new Error(
        `W3 schema already exists for pending migration ${name}; refusing DDL replay`,
      );
    }
  }
}

async function verifyInvoiceSchema(db: DataSource): Promise<void> {
  const [proof] = await db.query(`SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='invoices' AND column_name='shipping_policy_version') AS policy_version,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='invoices' AND column_name='customer_shipping_share') AS customer_share,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='invoices' AND column_name='technician_shipping_share') AS technician_share,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.invoices')
      AND conname='ck_invoice_shipping_policy') AS policy_check,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.invoices')
      AND conname='ck_invoice_shipping_cutover_closed') AS cutover_check,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.invoices')
      AND conname='ck_invoice_shipping_shares') AS shares_check,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.invoices')
      AND tgname='protect_invoice_financial_snapshot' AND tgenabled='O') AS snapshot_trigger,
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='protect_invoice_financial_snapshot') AS snapshot_function`);
  if (!proof || Object.values(proof).some((value) => value !== true)) {
    throw new Error(
      'W3 invoice schema proof incomplete; do not restart Backend',
    );
  }
}

async function verifyConsentSchema(db: DataSource): Promise<void> {
  const [proof] = await db.query(`SELECT
    to_regclass('public.delivery_consent_sessions') IS NOT NULL AS sessions,
    to_regclass('public.delivery_consent_commands') IS NOT NULL AS commands,
    to_regclass('public.delivery_evidence_records') IS NOT NULL AS evidence,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.delivery_consent_sessions')) AS sessions_rls,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.delivery_consent_commands')) AS commands_rls,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.delivery_evidence_records')) AS evidence_rls,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='delivery_consent_sessions' AND column_name='projection') AS session_projection,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='delivery_consent_sessions' AND column_name='status') AS session_status,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='delivery_consent_commands' AND column_name='snapshot') AS command_snapshot,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='delivery_consent_commands' AND column_name='result_version') AS command_version,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='delivery_evidence_records' AND column_name='private_object_ref') AS evidence_ref,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='delivery_evidence_records' AND column_name='content_digest') AS evidence_digest`);
  if (!proof || Object.values(proof).some((value) => value !== true)) {
    throw new Error(
      'W3 delivery consent schema proof incomplete; do not restart Backend',
    );
  }

  for (const index of [
    'uq_delivery_proposal_version',
    'uq_delivery_consent_actor',
    'uq_delivery_actual_version',
  ]) {
    const [row] = await db.query(
      `SELECT i.indisunique AS unique_index, i.indisvalid AS valid_index
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.oid=to_regclass($1)`,
      [`public.${index}`],
    );
    if (!row?.unique_index || !row?.valid_index) {
      throw new Error(`W3 delivery consent unique index missing: ${index}`);
    }
  }
  for (const index of [
    'ix_delivery_sessions_order',
    'ix_delivery_sessions_technician',
    'ix_delivery_sessions_customer',
    'ix_delivery_evidence_request',
  ]) {
    const [row] = await db.query('SELECT to_regclass($1) AS present', [
      `public.${index}`,
    ]);
    if (!row?.present)
      throw new Error(`W3 delivery consent index missing: ${index}`);
  }

  const triggers: Array<[string, string]> = [
    ['delivery_consent_sessions', 'delivery_session_guard'],
    ['delivery_consent_sessions', 'delivery_session_no_truncate'],
    ['delivery_consent_sessions', 'delivery_session_complete'],
    ['delivery_consent_commands', 'delivery_command_guard'],
    ['delivery_consent_commands', 'delivery_command_immutable'],
    ['delivery_consent_commands', 'delivery_command_no_truncate'],
    ['delivery_consent_commands', 'delivery_command_complete'],
    ['delivery_evidence_records', 'delivery_evidence_scope'],
    ['delivery_evidence_records', 'delivery_evidence_immutable'],
    ['delivery_evidence_records', 'delivery_evidence_no_truncate'],
  ];
  for (const [table, trigger] of triggers) {
    const [row] = await db.query(
      `SELECT tgenabled AS enabled FROM pg_trigger
      WHERE tgrelid=to_regclass($1) AND tgname=$2`,
      [`public.${table}`, trigger],
    );
    if (!row || row.enabled !== 'O') {
      throw new Error(`W3 delivery consent trigger missing: ${trigger}`);
    }
  }

  const functions = [
    'delivery_consent_scope_matches',
    'delivery_consent_session_guard',
    'delivery_evidence_scope_guard',
    'delivery_consent_append_only',
    'delivery_command_guard',
    'delivery_consent_journal_complete',
  ];
  const rows: Array<{ proname: string }> = await db.query(
    `SELECT DISTINCT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1)`,
    [functions],
  );
  if (rows.length !== functions.length) {
    throw new Error(
      'W3 delivery consent functions incomplete; do not restart Backend',
    );
  }
}

async function verifyPolicySchema(
  db: DataSource,
  lifecycle = false,
): Promise<void> {
  const [proof] = await db.query(`SELECT
    to_regclass('public.w3_delivery_policy_versions') IS NOT NULL AS policy_table,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.w3_delivery_policy_versions')) AS policy_rls,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.w3_delivery_policy_versions')
      AND conname='uq_w3_delivery_policy_revision') AS revision_unique,
    ${lifecycle ? "to_regclass('public.uq_w3_delivery_policy_draft_content') IS NOT NULL" : "EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.w3_delivery_policy_versions') AND conname='uq_w3_delivery_policy_content')"} AS content_unique,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.w3_delivery_policy_versions')
      AND conname='${lifecycle ? 'ck_w3_delivery_policy_operating' : 'ck_w3_delivery_policy_inert'}') AS inert_check,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.w3_delivery_policy_versions')
      AND conname='ck_w3_delivery_policy_revision') AS revision_check,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.w3_delivery_policy_versions')
      AND conname='ck_w3_delivery_policy_snapshot') AS snapshot_check`);
  if (!proof || Object.values(proof).some((value) => value !== true)) {
    throw new Error(
      'W3 delivery policy schema proof incomplete; do not restart Backend',
    );
  }

  const triggers: Array<[string, string]> = [
    ['w3_delivery_policy_versions', 'w3_delivery_policy_immutable'],
    ['w3_delivery_policy_versions', 'w3_delivery_policy_no_truncate'],
    ['w3_delivery_policy_versions', 'w3_delivery_policy_insert_guard'],
    ['w3_delivery_policy_versions', 'w3_delivery_policy_audit_complete'],
  ];
  for (const [table, trigger] of triggers) {
    const [row] = await db.query(
      `SELECT tgenabled AS enabled FROM pg_trigger
      WHERE tgrelid=to_regclass($1) AND tgname=$2`,
      [`public.${table}`, trigger],
    );
    if (!row || row.enabled !== 'O')
      throw new Error(`W3 delivery policy trigger missing: ${trigger}`);
  }

  const functions = [
    'w3_delivery_policy_append_only',
    'w3_delivery_policy_insert_guard',
    'w3_delivery_policy_audit_complete',
  ];
  const rows: Array<{ proname: string }> = await db.query(
    `SELECT DISTINCT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1)`,
    [functions],
  );
  if (rows.length !== functions.length) {
    throw new Error(
      'W3 delivery policy functions incomplete; do not restart Backend',
    );
  }
}

async function verifyPolicyLifecycleSchema(db: DataSource): Promise<void> {
  const [proof] = await db.query(`SELECT
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.w3_delivery_policy_previews')) AS preview_rls,
    NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid IN (to_regclass('public.w3_delivery_policy_previews'),to_regclass('public.w3_delivery_policy_versions'))) AS no_api_policy,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.w3_delivery_policy_versions') AND conname='fk_w3_policy_activation_preview') AS preview_fk,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='w3_delivery_policy_versions' AND column_name='activation_preview_id') AS preview_column`);
  if (!proof || Object.values(proof).some((value) => value !== true))
    throw new Error('W3 operating lifecycle schema proof incomplete');
  for (const index of [
    'uq_w3_delivery_policy_draft_content',
    'uq_w3_delivery_policy_activation_preview',
    'uq_w3_policy_audit_resource',
  ]) {
    const [row] = await db.query(
      `SELECT i.indisunique AND i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid=to_regclass($1)`,
      [`public.${index}`],
    );
    if (row?.valid !== true)
      throw new Error(`W3 operating lifecycle unique index missing: ${index}`);
  }
  for (const [table, trigger] of [
    ['w3_delivery_policy_previews', 'w3_delivery_policy_preview_guard'],
    ['w3_delivery_policy_previews', 'w3_policy_previews_immutable'],
    ['w3_delivery_policy_previews', 'w3_policy_previews_no_truncate'],
    ['w3_delivery_policy_previews', 'w3_delivery_policy_preview_complete'],
    ['audit_logs', 'w3_policy_audit_immutable'],
    ['audit_logs', 'w3_policy_audit_no_truncate'],
    ['audit_logs', 'w3_policy_audit_link_complete'],
  ]) {
    const [row] = await db.query(
      `SELECT tgenabled AS enabled FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname=$2`,
      [`public.${table}`, trigger],
    );
    if (row?.enabled !== 'O')
      throw new Error(`W3 operating lifecycle trigger missing: ${trigger}`);
  }
  const functions = [
    'w3_delivery_policy_insert_guard',
    'w3_delivery_policy_audit_complete',
    'w3_delivery_policy_insert_guard_draft_v1',
    'w3_delivery_policy_audit_complete_draft_v1',
    'w3_delivery_policy_preview_guard',
    'w3_delivery_policy_preview_complete',
    'w3_policy_audit_immutable',
    'w3_policy_audit_link_complete',
  ];
  const rows = await db.query(
    `SELECT p.oid,p.proname,EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1)`,
    [functions],
  );
  if (
    rows.length !== functions.length ||
    rows.some((row) => row.public_execute)
  )
    throw new Error(
      'W3 operating lifecycle functions missing or executable by PUBLIC',
    );
  const roles = await db.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')",
  );
  for (const role of roles)
    for (const fn of rows) {
      const [access] = await db.query(
        "SELECT has_function_privilege($1,$2::oid,'EXECUTE') AS allowed",
        [role.rolname, fn.oid],
      );
      if (access?.allowed)
        throw new Error(
          'Data API role can execute W3 operating lifecycle function',
        );
    }
}

/** 0008 renames the closed 0007 guards but recreates the same trigger/function
 * names, so this 0007 proof must stay valid before and after 0008. */
async function verifyPhysicalSchema(db: DataSource): Promise<void> {
  const [proof] = await db.query(`SELECT
    to_regclass('public.warehouse_delivery_gate') IS NOT NULL AS gate_table,
    to_regclass('public.warehouse_delivery_cohorts') IS NOT NULL AS cohort_table,
    to_regclass('public.warehouse_delivery_events') IS NOT NULL AS event_table,
    to_regclass('public.warehouse_delivery_movements') IS NOT NULL AS movement_table,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.warehouse_delivery_gate')) AS gate_rls,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.warehouse_delivery_cohorts')) AS cohort_rls,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.warehouse_delivery_events')) AS event_rls,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.warehouse_delivery_movements')) AS movement_rls,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.warehouse_delivery_gate')
      AND conname='ck_w3_physical_cutover_closed') AS cutover_check`);
  if (!proof || Object.values(proof).some((value) => value !== true)) {
    throw new Error(
      'W3 physical schema proof incomplete; do not restart Backend',
    );
  }

  const [gate] = await db.query(`SELECT count(*)::int AS rows,
    coalesce(bool_and(NOT enabled), false) AS closed FROM public.warehouse_delivery_gate`);
  if (gate?.rows !== 1 || gate?.closed !== true) {
    throw new Error(
      'W3 physical activation gate is not closed; do not restart Backend',
    );
  }

  const triggers: Array<[string, string]> = [
    ['warehouse_delivery_cohorts', 'guard_w3_delivery_cohort'],
    ['part_requests', 'guard_w3_delivery_legacy'],
    ['warehouse_delivery_events', 'guard_w3_delivery_event'],
    ['warehouse_delivery_movements', 'guard_w3_delivery_movement'],
    ['warehouse_delivery_gate', 'immutable_w3_history'],
    ['warehouse_delivery_gate', 'immutable_w3_truncate'],
    ['warehouse_delivery_cohorts', 'immutable_w3_history'],
    ['warehouse_delivery_cohorts', 'immutable_w3_truncate'],
    ['warehouse_delivery_events', 'immutable_w3_history'],
    ['warehouse_delivery_events', 'immutable_w3_truncate'],
    ['warehouse_delivery_movements', 'immutable_w3_history'],
    ['warehouse_delivery_movements', 'immutable_w3_truncate'],
  ];
  for (const [table, trigger] of triggers) {
    const [row] = await db.query(
      `SELECT tgenabled AS enabled FROM pg_trigger
      WHERE tgrelid=to_regclass($1) AND tgname=$2`,
      [`public.${table}`, trigger],
    );
    if (!row || row.enabled !== 'O')
      throw new Error(`W3 physical trigger missing: ${table}.${trigger}`);
  }

  const functions = [
    'protect_w3_physical_history',
    'guard_w3_delivery_cohort',
    'guard_w3_delivery_legacy_mutation',
    'guard_w3_delivery_event',
    'guard_w3_delivery_movement',
  ];
  const rows: Array<{ proname: string }> = await db.query(
    `SELECT DISTINCT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1)`,
    [functions],
  );
  if (rows.length !== functions.length) {
    throw new Error('W3 physical functions incomplete; do not restart Backend');
  }
}

async function verifyZeroFeeSchema(db: DataSource): Promise<void> {
  const tableColumns: Array<[string, string[]]> = [
    [
      'delivery_operation_evidence',
      [
        'id',
        'part_request_id',
        'service_order_id',
        'warehouse_id',
        'uploader_user_id',
        'purpose',
        'quote_version',
        'private_object_ref',
        'content_digest',
        'mime_type',
        'file_size',
        'created_at',
      ],
    ],
    [
      'delivery_shipping_proposals',
      [
        'part_request_id',
        'quote_version',
        'command_id',
        'warehouse_id',
        'responsible_user_id',
        'assignment_id',
        'context_digest',
        'courier_reference',
        'evidence_id',
        'created_at',
      ],
    ],
  ];
  for (const [table, columns] of tableColumns) {
    const rows: Array<{ column_name: string }> = await db.query(
      `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=ANY($2)`,
      [table, columns],
    );
    if (rows.length !== columns.length) {
      throw new Error(`W3 zero-fee columns incomplete: ${table}`);
    }
  }

  const [proof] = await db.query(`SELECT
    to_regclass('public.delivery_operation_evidence') IS NOT NULL AS evidence_table,
    to_regclass('public.delivery_shipping_proposals') IS NOT NULL AS proposal_table,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.delivery_operation_evidence')) AS evidence_rls,
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.delivery_shipping_proposals')) AS proposal_rls`);
  if (!proof || Object.values(proof).some((value) => value !== true)) {
    throw new Error(
      'W3 zero-fee schema proof incomplete; do not restart Backend',
    );
  }

  const constraints: Array<[string, string]> = [
    ['delivery_operation_evidence', 'delivery_operation_evidence_pkey'],
    [
      'delivery_operation_evidence',
      'delivery_operation_evidence_private_object_ref_key',
    ],
    [
      'delivery_operation_evidence',
      'delivery_operation_evidence_id_part_request_id_key',
    ],
    [
      'delivery_operation_evidence',
      'delivery_operation_evidence_part_request_id_fkey',
    ],
    [
      'delivery_operation_evidence',
      'delivery_operation_evidence_service_order_id_fkey',
    ],
    [
      'delivery_operation_evidence',
      'delivery_operation_evidence_warehouse_id_fkey',
    ],
    [
      'delivery_operation_evidence',
      'delivery_operation_evidence_uploader_user_id_fkey',
    ],
    [
      'delivery_operation_evidence',
      'delivery_operation_evidence_purpose_check',
    ],
    [
      'delivery_operation_evidence',
      'delivery_operation_evidence_quote_version_check',
    ],
    [
      'delivery_operation_evidence',
      'delivery_operation_evidence_content_digest_check',
    ],
    [
      'delivery_operation_evidence',
      'delivery_operation_evidence_mime_type_check',
    ],
    [
      'delivery_operation_evidence',
      'delivery_operation_evidence_file_size_check',
    ],
    ['delivery_operation_evidence', 'delivery_operation_evidence_check'],
    ['delivery_shipping_proposals', 'delivery_shipping_proposals_pkey'],
    [
      'delivery_shipping_proposals',
      'delivery_shipping_proposals_part_request_id_command_id_key',
    ],
    [
      'delivery_shipping_proposals',
      'delivery_shipping_proposals_part_request_id_fkey',
    ],
    [
      'delivery_shipping_proposals',
      'delivery_shipping_proposals_warehouse_id_fkey',
    ],
    [
      'delivery_shipping_proposals',
      'delivery_shipping_proposals_responsible_user_id_fkey',
    ],
    [
      'delivery_shipping_proposals',
      'delivery_shipping_proposals_assignment_id_fkey',
    ],
    [
      'delivery_shipping_proposals',
      'delivery_shipping_proposals_part_request_id_command_id_fkey',
    ],
    [
      'delivery_shipping_proposals',
      'delivery_shipping_proposals_evidence_id_part_request_id_fkey',
    ],
    [
      'delivery_shipping_proposals',
      'delivery_shipping_proposals_quote_version_check',
    ],
    [
      'delivery_shipping_proposals',
      'delivery_shipping_proposals_context_digest_check',
    ],
    [
      'delivery_shipping_proposals',
      'delivery_shipping_proposals_courier_reference_check',
    ],
  ];
  for (const [table, constraint] of constraints) {
    const [row] = await db.query(
      `SELECT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid=to_regclass($1) AND conname=$2) AS present`,
      [`public.${table}`, constraint],
    );
    if (!row?.present) {
      throw new Error(`W3 zero-fee constraint missing: ${constraint}`);
    }
  }

  const triggers: Array<[string, string]> = [
    ['delivery_operation_evidence', 'w3_live_evidence_guard'],
    ['delivery_operation_evidence', 'w3_live_immutable'],
    ['delivery_operation_evidence', 'w3_live_no_truncate'],
    ['delivery_shipping_proposals', 'w3_live_proposal_guard'],
    ['delivery_shipping_proposals', 'w3_live_immutable'],
    ['delivery_shipping_proposals', 'w3_live_no_truncate'],
    ['warehouse_delivery_events', 'guard_w3_delivery_event'],
    ['warehouse_delivery_events', 'w3_live_event_complete'],
    ['warehouse_delivery_movements', 'guard_w3_delivery_movement'],
    ['part_requests', 'w3_live_request_guard'],
    ['part_request_items', 'w3_live_item_guard'],
    ['invoices', 'w3_live_invoice_guard'],
    ['service_orders', 'w3_live_order_guard'],
    ['technician_assignments', 'w3_live_assignment_guard'],
    ['additional_cost_requests', 'w3_live_source_guard'],
    ['additional_cost_items', 'w3_live_source_items_guard'],
    ['warehouses', 'w3_live_warehouse_guard'],
  ];
  for (const [table, trigger] of triggers) {
    const [row] = await db.query(
      `SELECT tgenabled AS enabled FROM pg_trigger
      WHERE tgrelid=to_regclass($1) AND tgname=$2`,
      [`public.${table}`, trigger],
    );
    if (!row || row.enabled !== 'O') {
      throw new Error(`W3 zero-fee trigger missing: ${table}.${trigger}`);
    }
  }
  const [completion] = await db.query(`SELECT
    tgdeferrable AS deferrable, tginitdeferred AS initially_deferred
    FROM pg_trigger WHERE tgrelid=to_regclass('public.warehouse_delivery_events')
      AND tgname='w3_live_event_complete'`);
  if (!completion?.deferrable || !completion?.initially_deferred) {
    throw new Error(
      'W3 zero-fee movement completion trigger is not deferred; do not restart Backend',
    );
  }

  const functions = [
    'w3_live_quantities',
    'w3_live_source',
    'w3_live_evidence_guard',
    'w3_live_proposal_guard',
    'guard_w3_delivery_event',
    'guard_w3_delivery_event_closed',
    'guard_w3_delivery_movement',
    'guard_w3_delivery_movement_closed',
    'w3_live_event_complete',
    'w3_live_request_guard',
    'w3_live_item_guard',
    'w3_live_invoice_guard',
    'w3_live_order_guard',
    'w3_live_assignment_guard',
    'w3_live_source_guard',
    'w3_live_warehouse_guard',
  ];
  const rows: Array<{ proname: string }> = await db.query(
    `SELECT DISTINCT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1)`,
    [functions],
  );
  if (rows.length !== functions.length) {
    throw new Error('W3 zero-fee functions incomplete; do not restart Backend');
  }

  const [guards] = await db.query(`SELECT
    (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='guard_w3_delivery_event') AS event_guard,
    (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='guard_w3_delivery_event_closed') AS event_closed,
    (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='guard_w3_delivery_movement') AS movement_guard,
    (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='guard_w3_delivery_movement_closed') AS movement_closed`);
  if (
    !guards?.event_guard?.includes('delivery_shipping_proposals') ||
    guards?.event_closed?.includes('delivery_shipping_proposals') ||
    !guards?.movement_guard?.includes('warehouse_stock') ||
    guards?.movement_closed?.includes('warehouse_stock')
  ) {
    throw new Error(
      'W3 zero-fee guard replacement incomplete; do not restart Backend',
    );
  }

  const publicFunctions = [
    'w3_live_quantities',
    'w3_live_source',
    'w3_live_evidence_guard',
    'w3_live_proposal_guard',
    'guard_w3_delivery_event',
    'guard_w3_delivery_movement',
    'w3_live_event_complete',
    'w3_live_request_guard',
    'w3_live_item_guard',
    'w3_live_invoice_guard',
    'w3_live_order_guard',
    'w3_live_assignment_guard',
    'w3_live_source_guard',
    'w3_live_warehouse_guard',
  ];
  const executeRows: Array<{ proname: string; public_execute: boolean }> =
    await db.query(
      `SELECT p.proname, EXISTS (
        SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=ANY($1)`,
      [publicFunctions],
    );
  if (
    executeRows.length !== publicFunctions.length ||
    executeRows.some((row) => row.public_execute)
  ) {
    throw new Error('W3 zero-fee function is executable by PUBLIC');
  }
}

async function verifyAppliedW3Schema(
  db: DataSource,
  applied: Set<string>,
): Promise<void> {
  if (applied.has(W3_MIGRATIONS[0])) await verifyInvoiceSchema(db);
  if (applied.has(W3_MIGRATIONS[1])) await verifyConsentSchema(db);
  if (applied.has(W3_MIGRATIONS[2]))
    await verifyPolicySchema(db, applied.has(W3_MIGRATIONS[5]));
  if (applied.has(W3_MIGRATIONS[3])) await verifyPhysicalSchema(db);
  if (applied.has(W3_MIGRATIONS[4])) await verifyZeroFeeSchema(db);
  if (applied.has(W3_MIGRATIONS[5])) await verifyPolicyLifecycleSchema(db);
  if (applied.has(W3_MIGRATIONS[6])) await verifyFeeTermsSchema(db);
  if (applied.has(W3_MIGRATIONS[7])) await verifyPrequoteCommissionSchema(db);
}

async function verifyW3Schema(db: DataSource): Promise<void> {
  await verifyInvoiceSchema(db);
  await verifyConsentSchema(db);
  await verifyPolicySchema(db, true);
  await verifyPhysicalSchema(db);
  await verifyZeroFeeSchema(db);
  await verifyPolicyLifecycleSchema(db);
  await verifyFeeTermsSchema(db);
  await verifyPrequoteCommissionSchema(db);
}

async function verifyPrequoteCommissionSchema(db: DataSource): Promise<void> {
  const [proof] = await db.query(`SELECT
    (SELECT count(*)=2 FROM pg_class WHERE oid IN (to_regclass('public.w3_order_commission_snapshots'),to_regclass('public.w3_commission_config_versions')) AND relrowsecurity) AS rls,
    NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN (to_regclass('public.w3_order_commission_snapshots'),to_regclass('public.w3_commission_config_versions'))) AS no_policies,
    (SELECT count(*)=8 FROM pg_trigger WHERE (tgrelid=to_regclass('public.w3_order_commission_snapshots') AND tgname IN ('w3_order_commission_guard','w3_order_commission_immutable','w3_order_commission_no_truncate'))
      OR (tgrelid=to_regclass('public.w3_commission_config_versions') AND tgname IN ('w3_commission_config_version_guard','w3_commission_config_immutable','w3_commission_config_no_truncate'))
      OR (tgrelid=to_regclass('public.system_configs') AND tgname='w3_commission_config_capture')
      OR (tgrelid=to_regclass('public.delivery_fee_terms') AND tgname='w3_fee_terms_zz_commission')) AS triggers_present,
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('w3_order_commission_guard','w3_order_commission_immutable','w3_order_commission_no_truncate',
      'w3_commission_config_version_guard','w3_commission_config_immutable','w3_commission_config_no_truncate','w3_commission_config_capture','w3_fee_terms_zz_commission')
      AND tgenabled<>'O' AND tgrelid IN (to_regclass('public.w3_order_commission_snapshots'),to_regclass('public.w3_commission_config_versions'),to_regclass('public.system_configs'),to_regclass('public.delivery_fee_terms'))) AS triggers_enabled,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.w3_order_commission_snapshots') AND conname='fk_w3_commission_first_terms' AND convalidated AND condeferrable AND condeferred) AS deferred_terms,
    (SELECT count(*)=8 FROM pg_constraint WHERE conrelid=to_regclass('public.w3_order_commission_snapshots') AND convalidated) AS snapshot_constraints,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.delivery_fee_terms') AND conname='ck_w3_terms_commission_scope' AND convalidated) AS terms_scope,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.delivery_fee_terms') AND conname='delivery_fee_terms_commission_order_id_fkey' AND convalidated) AS terms_fk,
    (SELECT count(*)=2 FROM pg_proc WHERE oid IN (to_regprocedure('public.w3_approved_labor_source(uuid)'),to_regprocedure('public.w3_commission_config_snapshot()')) AND proconfig @> ARRAY['TimeZone=UTC']) AS canonical_timezone,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.delivery_fee_terms') AND attname='commission_order_id' AND NOT attisdropped) AS terms_binding,
    EXISTS(SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.w3_order_commission_snapshots') AND indisprimary AND indisvalid) AS order_unique,
    (SELECT count(*)=2 FROM pg_constraint WHERE conrelid=to_regclass('public.w3_commission_config_versions') AND contype IN ('p','u') AND convalidated) AS config_version_unique`);
  if (!proof || Object.values(proof).some((v) => v !== true))
    throw new Error('W3 prequote commission schema proof incomplete');
  const names = [
    'w3_commission_config_snapshot',
    'w3_commission_config_capture',
    'w3_approved_labor_source',
    'w3_prequote_commission_current',
    'w3_prequote_commission_guard',
  ];
  const functions = await db.query(
    `SELECT p.oid, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS exposed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1)`,
    [names],
  );
  if (functions.length !== names.length || functions.some((f) => f.exposed))
    throw new Error('W3 prequote commission function ACL incomplete');
  const sequenceName = 'public.w3_commission_config_versions_revision_seq';
  const [sequence] = await db.query(
    `SELECT c.relkind='S' AS valid,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('S',c.relowner))) a
        WHERE a.grantee=0 AND a.privilege_type IN ('USAGE','SELECT','UPDATE')) AS exposed
      FROM pg_class c WHERE c.oid=to_regclass($1)`,
    [sequenceName],
  );
  if (!sequence?.valid || sequence.exposed)
    throw new Error('W3 prequote commission sequence ACL incomplete');
  const roles = await db.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')",
  );
  for (const { rolname } of roles) {
    const [sequenceAccess] = await db.query(
      `SELECT has_sequence_privilege($1,$2,'USAGE') AS usage,
        has_sequence_privilege($1,$2,'SELECT') AS read,
        has_sequence_privilege($1,$2,'UPDATE') AS update`,
      [rolname, sequenceName],
    );
    if (
      !sequenceAccess ||
      Object.values(sequenceAccess).some((v) => v !== false)
    )
      throw new Error(
        'Data API role has W3 prequote commission sequence access',
      );
    for (const fn of functions) {
      const [access] = await db.query(
        "SELECT has_function_privilege($1,$2::oid,'EXECUTE') AS allowed",
        [rolname, fn.oid],
      );
      if (access?.allowed)
        throw new Error(
          'Data API role can execute W3 prequote commission function',
        );
    }
  }
}

async function verifyFeeTermsSchema(db: DataSource): Promise<void> {
  const columns = [
    'part_request_id',
    'service_order_id',
    'command_id',
    'expected_version',
    'result_version',
    'actor_user_id',
    'actor_role',
    'kind',
    'command_body',
    'source_snapshot',
    'state',
    'created_at',
  ];
  const rows = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public'
    AND table_name='delivery_fee_terms' AND column_name=ANY($1)`,
    [columns],
  );
  const [proof] = await db.query(`SELECT
    (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.delivery_fee_terms')) AS rls,
    NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.delivery_fee_terms')) AS no_policies,
    to_regclass('public.ix_delivery_fee_terms_order') IS NOT NULL AS order_index,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.delivery_fee_terms') AND contype='p') AS primary_key,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.delivery_fee_terms') AND contype='u') AS command_unique,
    (SELECT count(*)=8 FROM pg_constraint WHERE conrelid=to_regclass('public.delivery_fee_terms') AND convalidated
      AND conname IN ('delivery_fee_terms_pkey','delivery_fee_terms_part_request_id_command_id_key',
        'delivery_fee_terms_part_request_id_fkey','delivery_fee_terms_service_order_id_fkey','delivery_fee_terms_actor_user_id_fkey',
        'ck_w3_fee_expected_version','ck_w3_fee_result_version','ck_w3_fee_kind')) AS constraints,
    EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.w3_fee_source_snapshot(uuid)')
      AND proconfig @> ARRAY['TimeZone=UTC']) AS canonical_timezone,
    (SELECT count(*)=4 FROM pg_trigger WHERE tgrelid=to_regclass('public.delivery_fee_terms')
      AND tgname IN ('w3_fee_terms_guard','w3_fee_terms_immutable','w3_fee_terms_no_truncate','w3_fee_terms_complete') AND tgenabled='O') AS triggers,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.delivery_fee_terms') AND tgname='w3_fee_terms_complete'
      AND tgdeferrable AND tginitdeferred) AS strict_audit,
    (SELECT count(*)=2 FROM pg_trigger WHERE tgrelid=to_regclass('public.audit_logs')
      AND tgname IN ('w3_fee_audit_protect','w3_fee_audit_no_truncate') AND tgenabled='O') AS audit_protected,
    EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.ux_w3_fee_terms_audit') AND indisunique AND indisvalid) AS audit_unique,
    to_regprocedure('public.w3_live_evidence_guard_0008()') IS NOT NULL AS old_guard`);
  if (
    rows.length !== columns.length ||
    !proof ||
    Object.values(proof).some((v) => v !== true)
  )
    throw new Error('W3 conditional fee terms schema proof incomplete');
  const fns = [
    'w3_fee_source_snapshot',
    'w3_fee_terms_guard',
    'w3_live_evidence_guard',
    'w3_fee_terms_complete',
    'w3_fee_audit_protect',
  ];
  const functions = await db.query(
    `SELECT p.proname, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS exposed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1)`,
    [fns],
  );
  if (functions.length !== fns.length || functions.some((r) => r.exposed))
    throw new Error('W3 conditional fee terms function ACL incomplete');
  const roles = await db.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')",
  );
  for (const { rolname } of roles)
    for (const fn of [
      'w3_fee_source_snapshot(uuid)',
      'w3_fee_terms_guard()',
      'w3_fee_terms_complete()',
      'w3_fee_audit_protect()',
      'w3_live_evidence_guard()',
    ]) {
      const [access] = await db.query(
        "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
        [rolname, `public.${fn}`],
      );
      if (access?.allowed)
        throw new Error(
          'Data API role can execute W3 conditional fee terms function',
        );
    }
}

async function verifyW3Grants(db: DataSource): Promise<void> {
  for (const { table } of REQUIRED_APP_PRIVILEGES) {
    const [publicAcl] = await db.query(
      `SELECT EXISTS (
      SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid=to_regclass($1) AND a.grantee=0
        AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')) AS exposed`,
      [`public.${table}`],
    );
    if (publicAcl?.exposed)
      throw new Error(`PUBLIC has W3 private table access: ${table}`);
  }

  const roles: Array<{ rolname: string }> = await db.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')",
  );
  for (const { rolname } of roles) {
    for (const { table } of REQUIRED_APP_PRIVILEGES) {
      const [access] = await db.query(
        `SELECT
        has_table_privilege($1,$2,'SELECT') AS read,
        has_table_privilege($1,$2,'INSERT') AS insert,
        has_table_privilege($1,$2,'UPDATE') AS update,
        has_table_privilege($1,$2,'DELETE') AS delete`,
        [rolname, `public.${table}`],
      );
      if (Object.values(access ?? {}).some(Boolean)) {
        throw new Error(
          `Data API role has W3 private table access: ${rolname}`,
        );
      }
    }
  }

  for (const { table, privileges } of REQUIRED_APP_PRIVILEGES) {
    for (const privilege of privileges) {
      const [row] = await db.query(
        'SELECT has_table_privilege(current_user,$1,$2) AS allowed',
        [`public.${table}`, privilege],
      );
      if (!row?.allowed)
        throw new Error(`Backend role cannot use W3 table: ${table}`);
    }
  }
}

async function applyW3Migrations(
  db: DataSource,
  pending: string[],
): Promise<void> {
  const available = new Map<string, MigrationInterface>(
    db.migrations.map((migration) => [migration.name, migration]),
  );
  const ordered = pending.map((name) => {
    const migration = available.get(name);
    if (!migration) throw new Error(`W3 migration missing from image: ${name}`);
    return migration;
  });

  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    for (const migration of ordered) {
      await migration.up(runner);
      await runner.query(
        'INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)',
        [migrationTimestamp(migration.name), migration.name],
      );
    }
    await runner.commitTransaction();
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

export async function runW3DevGate(db: DataSource): Promise<string[]> {
  const lock = db.createQueryRunner();
  await lock.connect();
  let acquired = false;
  try {
    const [mutex] = await lock.query(
      'SELECT pg_try_advisory_lock($1,$2) AS acquired',
      [LOCK_NAMESPACE, LOCK_KEY],
    );
    if (!mutex?.acquired)
      throw new Error('Another W3 migration gate is running');
    acquired = true;

    await assertSafeRole(db);
    const [ledgerTable] = await db.query(
      "SELECT to_regclass('public.migrations') AS present",
    );
    if (!ledgerTable?.present) {
      throw new Error('Migration ledger missing; refusing W3 DEV deploy');
    }

    // The ledger is read once under the advisory lock and reused for every decision.
    const ledger: Array<{ name: string }> = await db.query(
      'SELECT name FROM public.migrations',
    );
    const applied = new Set(ledger.map((row) => row.name));
    const pending = planW3DevMigrations(
      ledger.map((row) => row.name),
      imageMigrationNames(db),
    );
    await assertPrerequisiteSchema(db);

    if (pending.length) {
      await verifyAppliedW3Schema(db, applied);
      await assertNoReplay(db, pending);
      await applyW3Migrations(db, pending);
      for (const name of pending) applied.add(name);
    }

    if (W3_MIGRATIONS.some((name) => !applied.has(name))) {
      throw new Error('W3 migration ledger incomplete; do not restart Backend');
    }
    await verifyW3Schema(db);
    await verifyW3Grants(db);
    return pending;
  } finally {
    if (acquired)
      await lock.query('SELECT pg_advisory_unlock($1,$2)', [
        LOCK_NAMESPACE,
        LOCK_KEY,
      ]);
    await lock.release();
  }
}
