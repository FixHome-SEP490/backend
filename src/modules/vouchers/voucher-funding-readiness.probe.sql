-- P0-A diagnostic only: run through the backend's existing DB connection/role.
-- A postgres/Supabase SQL-editor result does not prove the app role's access.
-- No credentials, customer rows, migrations or permission changes are needed.
BEGIN READ ONLY;

SELECT current_user AS probe_role, session_user AS session_role,
  current_schema() AS resolved_schema, current_setting('search_path') AS search_path,
  has_schema_privilege(current_user, 'public', 'USAGE') AS public_schema_usage,
  to_regclass('public.migrations') IS NOT NULL AS migrations_present,
  to_regclass('public.voucher_payment_links') IS NOT NULL AS links_present,
  to_regclass('public.voucher_funding_entries') IS NOT NULL AS entries_present;

-- If any relation above is absent/inaccessible, stop and ROLLBACK.
-- Missing SELECT rights can raise 42501 here; RLS can hide the marker/column.
-- Both are unavailable in the runtime guard, never evidence to bypass it.
WITH prerequisites AS (
  SELECT
    EXISTS (SELECT 1 FROM public.migrations
      WHERE name = 'VoucherFundingLedger1792994400001'
        AND timestamp = 1792994400001) AS marker_visible,
    EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'support_cases'
        AND column_name = 'voucher_gross_refund_vnd'
        AND data_type = 'bigint') AS refund_column_visible,
    NOT row_security_active('public.voucher_payment_links') AS links_rls_inactive,
    NOT row_security_active('public.voucher_funding_entries') AS entries_rls_inactive,
    has_table_privilege(current_user, 'public.voucher_payment_links', 'SELECT') AS links_select,
    has_table_privilege(current_user, 'public.voucher_payment_links', 'INSERT') AS links_insert,
    has_table_privilege(current_user, 'public.voucher_funding_entries', 'SELECT') AS entries_select,
    has_table_privilege(current_user, 'public.voucher_funding_entries', 'INSERT') AS entries_insert
)
SELECT *, marker_visible AND refund_column_visible
  AND links_rls_inactive AND entries_rls_inactive
  AND links_select AND links_insert AND entries_select AND entries_insert AS release_ready
FROM prerequisites;

-- Metadata only: confirm these names resolve to base tables, not replacement views.
SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner,
  c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('migrations', 'voucher_payment_links', 'voucher_funding_entries');

ROLLBACK;
