import { MigrationInterface, QueryRunner } from 'typeorm';

/** Private preparation evidence, NOT an approved deduction or spending ledger.
 * No API, application writer, role grant, payment or financial admission consumes it. */
export class W3DeductionPreparation1793466000012 implements MigrationInterface {
  name = 'W3DeductionPreparation1793466000012';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE w3_deduction_preparations (
        service_order_id uuid NOT NULL REFERENCES w3_order_commission_snapshots(service_order_id),
        revision integer NOT NULL,
        expected_revision integer NOT NULL,
        command_id uuid NOT NULL,
        actor_user_id uuid NOT NULL REFERENCES users(id), actor_role varchar(32) NOT NULL,
        recorded_by_db_role name NOT NULL,
        mandate_ref varchar(256) NOT NULL,
        statement_ref varchar(256) NOT NULL, statement_digest varchar(64) NOT NULL,
        explicit_zero boolean NOT NULL, entries jsonb NOT NULL,
        taxonomy_version varchar(32) NOT NULL DEFAULT 'W3_D_PREPARATION_V1',
        recorded_total bigint NOT NULL,
        commission_snapshot jsonb NOT NULL, fingerprint varchar(64) NOT NULL,
        mode varchar(32) NOT NULL DEFAULT 'PREPARATORY_ONLY',
        verification varchar(32) NOT NULL DEFAULT 'RECORDED_NOT_VERIFIED',
        financial_execution varchar(16) NOT NULL DEFAULT 'BLOCKED',
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(service_order_id,revision),
        UNIQUE(service_order_id,command_id),
        CONSTRAINT ck_w3_d_revision CHECK(expected_revision BETWEEN 0 AND 2147483646 AND revision=expected_revision+1),
        CONSTRAINT ck_w3_d_inert CHECK(mode='PREPARATORY_ONLY' AND verification='RECORDED_NOT_VERIFIED' AND financial_execution='BLOCKED'),
        CONSTRAINT ck_w3_d_taxonomy CHECK(taxonomy_version='W3_D_PREPARATION_V1'),
        CONSTRAINT ck_w3_d_total CHECK(recorded_total BETWEEN 0 AND 9007199254740991),
        CONSTRAINT ck_w3_d_statement CHECK(mandate_ref ~ '^[A-Za-z0-9][A-Za-z0-9:_/-]{0,255}$'
          AND statement_ref ~ '^[A-Za-z0-9][A-Za-z0-9:_/-]{0,255}$' AND statement_digest ~ '^[a-f0-9]{64}$'),
        CONSTRAINT ck_w3_d_fingerprint CHECK(fingerprint ~ '^[a-f0-9]{64}$')
      );

      CREATE FUNCTION w3_deduction_preparation_guard() RETURNS trigger LANGUAGE plpgsql SET timezone='UTC' AS $$
      DECLARE head integer; entry jsonb; total numeric:=0; ids text[]:=ARRAY[]::text[]; snapshot jsonb;
        keys text[]:=ARRAY['entryId','category','amount','evidenceRef','contentDigest'];
      BEGIN
        -- Same serialization root as conditional terms; never touches a wallet or payable.
        PERFORM 1 FROM service_orders WHERE id=NEW.service_order_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'W3_D_PREPARATION_ORDER_REQUIRED'; END IF;
        SELECT coalesce(max(revision),0) INTO head FROM w3_deduction_preparations WHERE service_order_id=NEW.service_order_id;
        IF NEW.expected_revision IS NULL OR NEW.expected_revision<>head THEN
          RAISE EXCEPTION 'W3_D_PREPARATION_CAS_CONFLICT'; END IF;
        PERFORM 1 FROM technician_assignments WHERE service_order_id=NEW.service_order_id ORDER BY id FOR SHARE;
        -- Identity attribution only. No role (including ADMIN) is a Finance mandate.
        SELECT role::text INTO NEW.actor_role FROM users WHERE id=NEW.actor_user_id AND is_active AND status::text='active' FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'W3_D_PREPARATION_ACTOR_REQUIRED'; END IF;
        -- Compatible subset of 0010/0011: Order -> assignment/actor -> config -> labor.
        -- Never wait for an actor while holding the global config lock: another order's
        -- terms may hold that actor and need config. Locks live until transaction end.
        PERFORM 1 FROM system_configs WHERE key='commission.rate_bps' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'W3_D_PREPARATION_CURRENT_COMMISSION_REQUIRED'; END IF;
        -- The rate-row lock also serializes its 0011 config-version capture trigger;
        -- version/snapshot history itself is immutable, so no reverse version lock.
        PERFORM 1 FROM bookings WHERE id=(SELECT booking_id FROM service_orders WHERE id=NEW.service_order_id) FOR SHARE;
        -- UPDATE on source parents also blocks FK child INSERT phantoms, not just
        -- edits to existing items. The Order lock similarly protects new source parents.
        PERFORM 1 FROM quotations WHERE service_order_id=NEW.service_order_id ORDER BY id FOR UPDATE;
        PERFORM 1 FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE service_order_id=NEW.service_order_id) ORDER BY id FOR SHARE;
        PERFORM 1 FROM additional_cost_requests WHERE service_order_id=NEW.service_order_id ORDER BY id FOR UPDATE;
        PERFORM 1 FROM additional_cost_items WHERE request_id IN (SELECT id FROM additional_cost_requests WHERE service_order_id=NEW.service_order_id) ORDER BY id FOR SHARE;
        IF NOT w3_prequote_commission_current(NEW.service_order_id) THEN
          RAISE EXCEPTION 'W3_D_PREPARATION_CURRENT_COMMISSION_REQUIRED'; END IF;
        SELECT to_jsonb(s) INTO STRICT snapshot FROM w3_order_commission_snapshots s WHERE s.service_order_id=NEW.service_order_id;
        IF jsonb_typeof(NEW.entries) IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'W3_D_PREPARATION_ENTRIES_REQUIRED'; END IF;
        IF jsonb_array_length(NEW.entries)>100 OR NEW.explicit_zero IS NULL OR
          NEW.explicit_zero IS DISTINCT FROM (jsonb_array_length(NEW.entries)=0) THEN
          RAISE EXCEPTION 'W3_D_PREPARATION_EXPLICIT_ZERO_REQUIRED'; END IF;
        FOR entry IN SELECT value FROM jsonb_array_elements(NEW.entries) LOOP
          IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR NOT (entry ?& keys) OR entry-keys<>'{}'::jsonb
            OR jsonb_typeof(entry->'entryId') IS DISTINCT FROM 'string'
            OR NOT coalesce(entry->>'entryId' ~ '^[A-Za-z0-9][A-Za-z0-9:_/-]{0,255}$',false)
            OR entry->>'entryId'=ANY(ids)
            OR jsonb_typeof(entry->'category') IS DISTINCT FROM 'string'
            OR NOT coalesce(entry->>'category' IN ('TAX_WITHHOLDING','LABOR_ADJUSTMENT','OTHER_DOCUMENTED'),false)
            OR jsonb_typeof(entry->'amount') IS DISTINCT FROM 'number'
            OR NOT coalesce(entry->>'amount' ~ '^[1-9][0-9]*$',false)
            OR jsonb_typeof(entry->'evidenceRef') IS DISTINCT FROM 'string'
            OR NOT coalesce(entry->>'evidenceRef' ~ '^[A-Za-z0-9][A-Za-z0-9:_/-]{0,255}$',false)
            OR jsonb_typeof(entry->'contentDigest') IS DISTINCT FROM 'string'
            OR NOT coalesce(entry->>'contentDigest' ~ '^[a-f0-9]{64}$',false) THEN
            RAISE EXCEPTION 'W3_D_PREPARATION_INVALID_ENTRY'; END IF;
          ids:=array_append(ids,entry->>'entryId'); total:=total+(entry->>'amount')::numeric;
          IF total>9007199254740991 THEN RAISE EXCEPTION 'W3_D_PREPARATION_AMOUNT_OUT_OF_RANGE'; END IF;
        END LOOP;
        -- Each revision replaces the full statement for diagnostics; history is never edited.
        -- Canonical entry ordering makes its digest independent of array order.
        SELECT coalesce(jsonb_agg(value ORDER BY value->>'entryId'),'[]'::jsonb) INTO NEW.entries FROM jsonb_array_elements(NEW.entries);
        NEW.revision:=NEW.expected_revision+1; NEW.recorded_total:=total::bigint;
        NEW.commission_snapshot:=snapshot; NEW.created_at:=now(); NEW.recorded_by_db_role:=current_user;
        NEW.fingerprint:=encode(sha256(convert_to(jsonb_build_array(NEW.service_order_id,NEW.revision,NEW.command_id,
          NEW.actor_user_id,NEW.actor_role,NEW.recorded_by_db_role,NEW.mandate_ref,NEW.statement_ref,NEW.statement_digest,
          NEW.explicit_zero,NEW.entries,NEW.taxonomy_version,snapshot,NEW.mode,NEW.verification,NEW.financial_execution)::text,'UTF8')),'hex');
        RETURN NEW;
      END $$;
      CREATE TRIGGER w3_d_preparation_guard BEFORE INSERT ON w3_deduction_preparations
        FOR EACH ROW EXECUTE FUNCTION w3_deduction_preparation_guard();
      CREATE TRIGGER w3_d_preparation_immutable BEFORE UPDATE OR DELETE ON w3_deduction_preparations
        FOR EACH ROW EXECUTE FUNCTION protect_w3_physical_history();
      CREATE TRIGGER w3_d_preparation_no_truncate BEFORE TRUNCATE ON w3_deduction_preparations
        FOR EACH STATEMENT EXECUTE FUNCTION protect_w3_physical_history();

      -- Internal point-in-time diagnostics only, no private references/actor IDs or readiness verdict.
      -- STABLE + a single SELECT use one statement snapshot; no financial state is changed.
      CREATE FUNCTION w3_finance_readiness(order_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET timezone='UTC' AS $$
        SELECT jsonb_build_object('version','W3_FINANCE_READINESS_V1','mode','PREPARATORY_ONLY',
          'financialExecution','BLOCKED','aggregateBudgetVerified',false,'laborBudget',null,'approvedDeductions',null,
          'commission',CASE WHEN s.service_order_id IS NULL THEN 'NOT_RECORDED'
            WHEN w3_prequote_commission_current(o.id) THEN 'CURRENT_PREPARATION' ELSE 'STALE_PREPARATION' END,
          'deductionState',CASE WHEN d.revision IS NULL THEN 'NOT_RECORDED'
            WHEN d.commission_snapshot IS DISTINCT FROM to_jsonb(s) OR NOT w3_prequote_commission_current(o.id)
              THEN 'STALE_COMMISSION' ELSE 'RECORDED_UNAPPROVED' END,
          'deductionRevision',d.revision,'recordedDeductions',d.recorded_total,'explicitZero',d.explicit_zero,
          'blockers',jsonb_build_array('FINANCE_LEGAL_SIGNOFF_REQUIRED','DEDUCTION_AUTHORITY_UNAPPROVED',
            'PERSISTENT_COMMITMENTS_REQUIRED','COURIER_VERIFICATION_REQUIRED','FUNDING_REFUND_ADAPTERS_REQUIRED',
            'SELLER_TAX_PAYEE_UNKNOWN','INVOICE_CUSTODY_CUTOVER_REQUIRED'))
        FROM service_orders o LEFT JOIN w3_order_commission_snapshots s ON s.service_order_id=o.id
        LEFT JOIN LATERAL (SELECT * FROM w3_deduction_preparations WHERE service_order_id=o.id ORDER BY revision DESC LIMIT 1) d ON true
        WHERE o.id=order_id
      $$;
      ALTER TABLE w3_deduction_preparations ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON w3_deduction_preparations FROM PUBLIC;
      REVOKE ALL ON FUNCTION w3_deduction_preparation_guard(),w3_finance_readiness(uuid) FROM PUBLIC;
      DO $$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
          EXECUTE format('REVOKE ALL ON w3_deduction_preparations FROM %I',role_name);
          EXECUTE format('REVOKE ALL ON FUNCTION w3_deduction_preparation_guard(),w3_finance_readiness(uuid) FROM %I',role_name);
        END IF;
      END LOOP; END $$;
      -- No sequence, SECURITY DEFINER, grants, policy, seed/backfill or runtime writer.
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`LOCK TABLE w3_deduction_preparations IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM w3_deduction_preparations) THEN
        RAISE EXCEPTION 'Refusing to discard W3 deduction preparation history'; END IF; END $$;
      DROP FUNCTION w3_finance_readiness(uuid);
      DROP TABLE w3_deduction_preparations;
      DROP FUNCTION w3_deduction_preparation_guard();`);
  }
}
