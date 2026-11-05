import { MigrationInterface, QueryRunner } from 'typeorm';

/** B1 storage ONLY. No enrollment, grants, source backfill, dispatch or invoice cutover.
 * All application writes must use the caller transaction and canonical Order -> Tech -> PR
 * locks. Triggers validate matching scope, not JWT authentication or Finance budget provenance. */
export class DeliveryConsentState1793466000005 implements MigrationInterface {
  name = 'DeliveryConsentState1793466000005';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE delivery_consent_sessions (
        part_request_id uuid PRIMARY KEY REFERENCES part_requests(id) ON DELETE RESTRICT,
        service_order_id uuid NOT NULL REFERENCES service_orders(id) ON DELETE RESTRICT,
        customer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        technician_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        active_assignment_id uuid NOT NULL REFERENCES technician_assignments(id) ON DELETE RESTRICT,
        responsible_service_manager_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        warehouse_id uuid REFERENCES warehouses(id) ON DELETE RESTRICT,
        source_quotation_id uuid REFERENCES quotations(id) ON DELETE RESTRICT,
        source_additional_cost_id uuid REFERENCES additional_cost_requests(id) ON DELETE RESTRICT,
        version integer NOT NULL CHECK (version > 0),
        quote_version integer NOT NULL CHECK (quote_version > 0 AND quote_version <= version),
        status varchar(32) NOT NULL CHECK (status IN ('AWAITING_DUAL_CONSENT','CONSENTED','ACTUAL_RECORDED')),
        projection jsonb NOT NULL,
        invalidated_at timestamptz, invalidation_reason varchar(32),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_delivery_b1_no_warehouse CHECK (warehouse_id IS NULL),
        CHECK (num_nonnulls(source_quotation_id, source_additional_cost_id) = 1),
        CHECK (customer_user_id <> technician_user_id AND customer_user_id <> responsible_service_manager_id
          AND technician_user_id <> responsible_service_manager_id),
        CHECK ((invalidated_at IS NULL AND invalidation_reason IS NULL) OR
          (invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL AND invalidation_reason = 'SCOPE_CHANGED')),
        CHECK (NOT projection ? 'receipts'),
        CHECK (COALESCE(projection @> jsonb_build_object('version',version,'status',status,
          'scope',jsonb_build_object('partRequestId',part_request_id,'serviceOrderId',service_order_id,
            'customerId',customer_user_id,'technicianId',technician_user_id,'responsibleServiceManagerId',responsible_service_manager_id),
          'quote',jsonb_build_object('quoteVersion',quote_version,'policyVersion','W3_70_30_V1')),false)),
        CHECK (COALESCE(projection->>'payoutBlockReason' IN ('FINANCIAL_CUTOVER_CLOSED','KNOWN_DEDUCTIONS_LEDGER_REQUIRED'),false)),
        CHECK (projection ?& ARRAY['version','scope','quote','customerConsent','technicianConsent','actual','status','payoutBlockReason']
          AND projection-ARRAY['version','scope','quote','customerConsent','technicianConsent','actual','status','payoutBlockReason']='{}'::jsonb),
        CHECK (COALESCE(projection#>>'{quote,fingerprint}' ~ '^[a-f0-9]{64}$',false))
      );
      CREATE INDEX ix_delivery_sessions_order ON delivery_consent_sessions(service_order_id);
      CREATE INDEX ix_delivery_sessions_technician ON delivery_consent_sessions(technician_user_id);
      CREATE INDEX ix_delivery_sessions_customer ON delivery_consent_sessions(customer_user_id);

      CREATE TABLE delivery_evidence_records (
        id uuid PRIMARY KEY,
        part_request_id uuid NOT NULL REFERENCES part_requests(id) ON DELETE RESTRICT,
        service_order_id uuid NOT NULL REFERENCES service_orders(id) ON DELETE RESTRICT,
        uploader_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        purpose varchar(8) NOT NULL CHECK (purpose IN ('QUOTE','ACTUAL')),
        quote_version integer NOT NULL CHECK (quote_version > 0),
        private_object_ref varchar(512) NOT NULL,
        content_digest char(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
        mime_type varchar(32) NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
        file_size integer NOT NULL CHECK (file_size BETWEEN 1 AND 10485760),
        retain_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(id,part_request_id),
        CHECK (private_object_ref ~ ('^cloudinary://evidence/fixhome/evidence/' || service_order_id::text || '/' || uploader_user_id::text ||
          '/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'))
      );
      CREATE INDEX ix_delivery_evidence_request ON delivery_evidence_records(part_request_id,quote_version);

      CREATE TABLE delivery_consent_commands (
        part_request_id uuid NOT NULL REFERENCES delivery_consent_sessions(part_request_id) ON DELETE RESTRICT,
        command_id uuid NOT NULL CHECK (command_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
        actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        actor_role varchar(32) NOT NULL CHECK (actor_role IN ('customer','technician','service_manager')),
        kind varchar(24) NOT NULL CHECK (kind IN ('PROPOSE','REVISE','CONSENT','RECORD_ACTUAL')),
        expected_version integer NOT NULL CHECK (expected_version >= 0),
        result_version integer NOT NULL CHECK (result_version::bigint = expected_version::bigint + 1),
        quote_version integer NOT NULL CHECK (quote_version > 0 AND quote_version <= result_version),
        quote_command_id uuid NOT NULL,
        command_body jsonb NOT NULL,
        content_fingerprint char(64) NOT NULL CHECK (content_fingerprint ~ '^[a-f0-9]{64}$'),
        source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
        source_digest char(64) NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
        source_version integer CHECK (source_version > 0),
        evidence_id uuid,
        snapshot jsonb NOT NULL,
        shipping_total bigint NOT NULL CHECK (shipping_total BETWEEN 0 AND 9007199254740991),
        customer_share bigint NOT NULL CHECK (customer_share BETWEEN 0 AND 9007199254740991),
        technician_share bigint NOT NULL CHECK (technician_share BETWEEN 0 AND 9007199254740991),
        labor_total bigint NOT NULL CHECK (labor_total BETWEEN 0 AND 9007199254740991),
        commission_amount bigint NOT NULL CHECK (commission_amount BETWEEN 0 AND 9007199254740991),
        known_deductions bigint NOT NULL CHECK (known_deductions BETWEEN 0 AND 9007199254740991),
        net_labor bigint NOT NULL CHECK (net_labor BETWEEN 0 AND 9007199254740991),
        actual_total bigint, actual_customer_share bigint, actual_technician_share bigint, consent_share bigint,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(part_request_id,command_id), UNIQUE(part_request_id,result_version),
        FOREIGN KEY(part_request_id,quote_command_id) REFERENCES delivery_consent_commands(part_request_id,command_id)
          ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY(evidence_id,part_request_id) REFERENCES delivery_evidence_records(id,part_request_id) ON DELETE RESTRICT,
        CHECK (customer_share::numeric = floor((7 * shipping_total::numeric + 5)/10)
          AND technician_share::numeric = shipping_total::numeric - customer_share::numeric),
        CHECK (net_labor::numeric = labor_total::numeric - commission_amount::numeric - known_deductions::numeric - technician_share::numeric),
        CHECK ((kind = 'CONSENT' AND actor_role IN ('customer','technician') AND evidence_id IS NULL AND consent_share IS NOT NULL
          AND consent_share = CASE WHEN actor_role='customer' THEN customer_share ELSE technician_share END)
          OR (kind <> 'CONSENT' AND actor_role='service_manager' AND evidence_id IS NOT NULL AND consent_share IS NULL)),
        CHECK ((kind <> 'RECORD_ACTUAL' AND num_nonnulls(actual_total,actual_customer_share,actual_technician_share)=0)
          OR (kind='RECORD_ACTUAL' AND num_nonnulls(actual_total,actual_customer_share,actual_technician_share)=3
            AND actual_total BETWEEN 0 AND shipping_total AND actual_customer_share >= 0 AND actual_technician_share >= 0
            AND actual_customer_share::numeric=floor((7*actual_total::numeric+5)/10)
            AND actual_technician_share::numeric=actual_total::numeric-actual_customer_share::numeric)),
        CHECK (COALESCE(command_body @> jsonb_build_object('commandId',command_id,'kind',kind,'expectedVersion',expected_version),false)),
        CHECK (NOT snapshot ? 'receipts'),
        CHECK (COALESCE(snapshot @> jsonb_build_object('version',result_version,'quote',jsonb_build_object(
          'quoteVersion',quote_version,'policyVersion','W3_70_30_V1','totalShippingFee',shipping_total,
          'customerShippingShare',customer_share,'technicianShippingShare',technician_share,'netLaborAfterShipping',net_labor,
          'budget',jsonb_build_object('laborTotal',labor_total,'commissionAmount',commission_amount,'knownApprovedDeductions',known_deductions))),false))
      );
      CREATE UNIQUE INDEX uq_delivery_proposal_version ON delivery_consent_commands(part_request_id,quote_version) WHERE kind IN ('PROPOSE','REVISE');
      CREATE UNIQUE INDEX uq_delivery_consent_actor ON delivery_consent_commands(part_request_id,quote_version,actor_role) WHERE kind='CONSENT';
      CREATE UNIQUE INDEX uq_delivery_actual_version ON delivery_consent_commands(part_request_id,quote_version) WHERE kind='RECORD_ACTUAL';

      -- Matching identities, not standalone existence checks. No triggers on live W2 tables:
      -- reassignment remains legal; stale sessions block subsequent commands and can invalidate.
      CREATE FUNCTION delivery_consent_scope_matches(s delivery_consent_sessions) RETURNS boolean LANGUAGE sql AS $$
        SELECT EXISTS (
          SELECT 1 FROM part_requests p JOIN service_orders o ON o.id=p.service_order_id
          JOIN bookings b ON b.id=o.booking_id
          JOIN technician_assignments a ON a.id=(s).active_assignment_id
          JOIN users c ON c.id=(s).customer_user_id JOIN users t ON t.id=(s).technician_user_id
          JOIN users m ON m.id=(s).responsible_service_manager_id
          LEFT JOIN quotations qt ON qt.id=(s).source_quotation_id
          LEFT JOIN additional_cost_requests ac ON ac.id=(s).source_additional_cost_id
          WHERE p.id=(s).part_request_id AND p.service_order_id=(s).service_order_id AND p.technician_id=(s).technician_user_id
            AND p.fulfillment_method::text='delivery' AND b.customer_id=(s).customer_user_id
            AND a.service_order_id=(s).service_order_id AND a.technician_id=(s).technician_user_id AND a.is_active
            AND c.role::text='customer' AND t.role::text='technician' AND m.role::text='service_manager'
            AND c.is_active AND t.is_active AND m.is_active AND c.status::text='active' AND t.status::text='active' AND m.status::text='active'
            AND p.quotation_id IS NOT DISTINCT FROM (s).source_quotation_id
            AND p.additional_cost_id IS NOT DISTINCT FROM (s).source_additional_cost_id
            AND ((p.request_type::text='quotation' AND qt.status::text='approved' AND qt.decided_at IS NOT NULL
                AND qt.service_order_id=o.id AND qt.technician_id=p.technician_id)
              OR (p.request_type::text='additional' AND ac.status::text='approved' AND ac.decided_at IS NOT NULL
                AND ac.service_order_id=o.id AND ac.technician_id=p.technician_id AND ac.decided_by_customer_id=b.customer_id))
            -- B1 cannot bind ANY W2 PICKUP allocation, regardless of its status.
            -- A future DELIVERY authority needs a separately reviewed forward migration.
            AND (s).warehouse_id IS NULL
        )
      $$;
      CREATE FUNCTION delivery_consent_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Delivery consent history cannot be deleted'; END IF;
        IF TG_OP='UPDATE' THEN
          IF (to_jsonb(NEW)-ARRAY['version','quote_version','status','projection','invalidated_at','invalidation_reason','updated_at'])
            IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','quote_version','status','projection','invalidated_at','invalidation_reason','updated_at'])
            OR OLD.invalidated_at IS NOT NULL THEN RAISE EXCEPTION 'Delivery session identity is immutable'; END IF;
          IF NEW.invalidated_at IS NOT NULL THEN
            IF NEW.invalidation_reason IS DISTINCT FROM 'SCOPE_CHANGED' OR NEW.version<>OLD.version OR NEW.quote_version<>OLD.quote_version
              OR NEW.status<>OLD.status OR NEW.projection<>OLD.projection OR delivery_consent_scope_matches(OLD)
              THEN RAISE EXCEPTION 'Invalid delivery scope invalidation'; END IF;
            RETURN NEW;
          END IF;
          IF NEW.version::bigint<>OLD.version::bigint+1 THEN RAISE EXCEPTION 'Delivery CAS version must advance once'; END IF;
        ELSIF NEW.version<>1 OR NEW.quote_version<>1 OR NEW.invalidated_at IS NOT NULL THEN
          RAISE EXCEPTION 'Delivery session must start at version one';
        END IF;
        -- Shared locks pin the matching scope until commit. Normal adapter already owns
        -- Order -> Technician -> PartRequest; do not reverse this order in future callers.
        PERFORM 1 FROM service_orders WHERE id=NEW.service_order_id FOR SHARE;
        PERFORM 1 FROM users WHERE id=NEW.technician_user_id FOR SHARE;
        PERFORM 1 FROM part_requests WHERE id=NEW.part_request_id FOR SHARE;
        PERFORM 1 FROM bookings WHERE id=(SELECT booking_id FROM service_orders WHERE id=NEW.service_order_id) FOR SHARE;
        PERFORM 1 FROM technician_assignments WHERE id=NEW.active_assignment_id FOR SHARE;
        PERFORM 1 FROM users WHERE id IN (NEW.customer_user_id,NEW.responsible_service_manager_id) ORDER BY id FOR SHARE;
        PERFORM 1 FROM quotations WHERE id=NEW.source_quotation_id FOR SHARE;
        PERFORM 1 FROM additional_cost_requests WHERE id=NEW.source_additional_cost_id FOR SHARE;
        IF NOT delivery_consent_scope_matches(NEW) THEN RAISE EXCEPTION 'Delivery scope mismatch'; END IF;
        IF EXISTS (SELECT 1 FROM invoices WHERE service_order_id=NEW.service_order_id)
          OR EXISTS (SELECT 1 FROM service_orders WHERE id=NEW.service_order_id AND (status::text IN ('completed','cancelled') OR completion_requested_at IS NOT NULL))
          OR EXISTS (SELECT 1 FROM part_requests WHERE id=NEW.part_request_id AND status::text IN ('cancelled','completed','received'))
          THEN RAISE EXCEPTION 'Delivery source is frozen'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER delivery_session_guard BEFORE INSERT OR UPDATE OR DELETE ON delivery_consent_sessions
        FOR EACH ROW EXECUTE FUNCTION delivery_consent_session_guard();

      CREATE FUNCTION delivery_evidence_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        -- Evidence exists BEFORE a proposal/session: never dereference a missing session here.
        IF NOT EXISTS (SELECT 1 FROM part_requests p JOIN users u ON u.id=NEW.uploader_user_id
          WHERE p.id=NEW.part_request_id AND p.service_order_id=NEW.service_order_id AND p.fulfillment_method::text='delivery'
            AND p.request_type::text IN ('additional','quotation') AND u.role::text='service_manager' AND u.is_active AND u.status::text='active')
          THEN RAISE EXCEPTION 'Delivery evidence scope mismatch'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER delivery_evidence_scope BEFORE INSERT ON delivery_evidence_records
        FOR EACH ROW EXECUTE FUNCTION delivery_evidence_scope_guard();

      CREATE FUNCTION delivery_consent_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Delivery receipts and evidence are append only'; END $$;
      CREATE TRIGGER delivery_command_immutable BEFORE UPDATE OR DELETE ON delivery_consent_commands
        FOR EACH ROW EXECUTE FUNCTION delivery_consent_append_only();
      CREATE TRIGGER delivery_evidence_immutable BEFORE UPDATE OR DELETE ON delivery_evidence_records
        FOR EACH ROW EXECUTE FUNCTION delivery_consent_append_only();
      CREATE TRIGGER delivery_session_no_truncate BEFORE TRUNCATE ON delivery_consent_sessions
        FOR EACH STATEMENT EXECUTE FUNCTION delivery_consent_append_only();
      CREATE TRIGGER delivery_command_no_truncate BEFORE TRUNCATE ON delivery_consent_commands
        FOR EACH STATEMENT EXECUTE FUNCTION delivery_consent_append_only();
      CREATE TRIGGER delivery_evidence_no_truncate BEFORE TRUNCATE ON delivery_evidence_records
        FOR EACH STATEMENT EXECUTE FUNCTION delivery_consent_append_only();

      CREATE FUNCTION delivery_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s delivery_consent_sessions; parent delivery_consent_commands; prev delivery_consent_commands; expected_source text;
        expected_actor uuid; expected_block_reason text; expected_status text;
      BEGIN
        SELECT * INTO STRICT s FROM delivery_consent_sessions WHERE part_request_id=NEW.part_request_id;
        -- Evaluate CASE values as PL/pgSQL assignments, not inline in IF predicates.
        -- Keep the same actor, deduction and consent/status invariants.
        expected_actor := CASE NEW.actor_role WHEN 'customer' THEN s.customer_user_id WHEN 'technician' THEN s.technician_user_id ELSE s.responsible_service_manager_id END;
        expected_block_reason := CASE WHEN NEW.known_deductions>0 THEN 'KNOWN_DEDUCTIONS_LEDGER_REQUIRED' ELSE 'FINANCIAL_CUTOVER_CLOSED' END;
        expected_status := CASE WHEN NEW.snapshot->'actual'<>'null'::jsonb THEN 'ACTUAL_RECORDED'
          WHEN NEW.snapshot->'customerConsent'<>'null'::jsonb AND NEW.snapshot->'technicianConsent'<>'null'::jsonb THEN 'CONSENTED' ELSE 'AWAITING_DUAL_CONSENT' END;
        IF s.invalidated_at IS NOT NULL OR NOT delivery_consent_scope_matches(s) OR s.version<>NEW.result_version
          OR s.projection<>NEW.snapshot OR s.quote_version<>NEW.quote_version THEN RAISE EXCEPTION 'Delivery command/root mismatch'; END IF;
        IF NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.actor_user_id AND role::text=NEW.actor_role AND is_active AND status::text='active')
          OR NEW.actor_user_id <> expected_actor
          THEN RAISE EXCEPTION 'Delivery command actor mismatch'; END IF;
        IF s.source_quotation_id IS NOT NULL THEN
          SELECT 'quotation:'||id||':'||version INTO expected_source FROM quotations WHERE id=s.source_quotation_id AND version=NEW.source_version;
          IF NOT EXISTS (SELECT 1 FROM quotations qt WHERE qt.id=s.source_quotation_id
            AND NEW.source_snapshot @> jsonb_build_object('id',qt.id,'serviceOrderId',s.service_order_id,
              'technicianId',s.technician_user_id,'status','approved','version',qt.version))
            THEN RAISE EXCEPTION 'Quotation source snapshot mismatch'; END IF;
        ELSE
          IF NEW.source_version IS NOT NULL THEN RAISE EXCEPTION 'Additional cost has no version column'; END IF;
          expected_source := 'additional-cost:'||s.source_additional_cost_id;
          IF NOT EXISTS (SELECT 1 FROM additional_cost_requests ac WHERE ac.id=s.source_additional_cost_id
            AND NEW.source_snapshot @> jsonb_build_object('id',ac.id,'serviceOrderId',s.service_order_id,
              'technicianId',s.technician_user_id,'status','approved','decidedByCustomerId',s.customer_user_id))
            THEN RAISE EXCEPTION 'Additional cost source snapshot mismatch'; END IF;
        END IF;
        IF expected_source IS NULL OR NEW.snapshot#>>'{quote,approvedCostRef}' IS DISTINCT FROM expected_source THEN RAISE EXCEPTION 'Delivery source binding mismatch'; END IF;
        IF NEW.snapshot->>'payoutBlockReason' IS DISTINCT FROM expected_block_reason
          THEN RAISE EXCEPTION 'Delivery financial gate must remain closed'; END IF;
        IF NEW.expected_version>0 THEN
          SELECT * INTO STRICT prev FROM delivery_consent_commands WHERE part_request_id=NEW.part_request_id AND result_version=NEW.expected_version;
        END IF;
        IF NEW.kind IN ('PROPOSE','REVISE') THEN
          IF NEW.quote_command_id<>NEW.command_id OR (NEW.kind='PROPOSE' AND (NEW.expected_version<>0 OR NEW.quote_version<>1))
            OR (NEW.kind='REVISE' AND (NEW.expected_version=0 OR NEW.quote_version::bigint<>prev.quote_version::bigint+1))
            OR NOT (NEW.snapshot @> '{"customerConsent":null,"technicianConsent":null,"actual":null,"status":"AWAITING_DUAL_CONSENT"}')
            OR NOT (NEW.command_body @> jsonb_build_object('totalShippingFee',NEW.shipping_total,'budget',NEW.snapshot#>'{quote,budget}',
              'approvedCostRef',expected_source,'evidenceRef','delivery-evidence:'||NEW.evidence_id))
            THEN RAISE EXCEPTION 'Invalid delivery proposal transition'; END IF;
        ELSE
          SELECT * INTO STRICT parent FROM delivery_consent_commands WHERE part_request_id=NEW.part_request_id AND command_id=NEW.quote_command_id AND kind IN ('PROPOSE','REVISE');
          IF NEW.expected_version=0 OR NEW.quote_version<>prev.quote_version OR parent.quote_version<>NEW.quote_version
            OR NEW.snapshot->'quote'<>parent.snapshot->'quote' OR NEW.source_digest<>parent.source_digest OR NEW.source_snapshot<>parent.source_snapshot
            OR NEW.source_version IS DISTINCT FROM parent.source_version THEN RAISE EXCEPTION 'Delivery proposal snapshot changed'; END IF;
          IF NEW.kind='CONSENT' THEN
            IF NOT (NEW.command_body @> jsonb_build_object('quoteVersion',NEW.quote_version,'quoteFingerprint',NEW.snapshot#>>'{quote,fingerprint}',
              'totalShippingFee',NEW.shipping_total,'shippingShare',NEW.consent_share,'accepted',true,'evidenceRef','delivery-consent:'||NEW.part_request_id||':'||NEW.command_id))
              OR (NEW.actor_role='customer' AND (prev.snapshot->'customerConsent'<>'null'::jsonb OR
                (NEW.snapshot-ARRAY['version','status','customerConsent'])<>(prev.snapshot-ARRAY['version','status','customerConsent'])))
              OR (NEW.actor_role='technician' AND (prev.snapshot->'technicianConsent'<>'null'::jsonb OR
                (NEW.snapshot-ARRAY['version','status','technicianConsent'])<>(prev.snapshot-ARRAY['version','status','technicianConsent'])))
              OR NOT (NEW.snapshot->CASE WHEN NEW.actor_role='customer' THEN 'customerConsent' ELSE 'technicianConsent' END @>
                (NEW.command_body || jsonb_build_object('actor',jsonb_build_object('id',NEW.actor_user_id,'role',NEW.actor_role),'contentFingerprint',NEW.content_fingerprint)))
              THEN RAISE EXCEPTION 'Invalid delivery consent transition'; END IF;
          ELSE
            IF prev.snapshot->'customerConsent'='null'::jsonb OR prev.snapshot->'technicianConsent'='null'::jsonb OR prev.snapshot->'actual'<>'null'::jsonb
              OR (NEW.snapshot-ARRAY['version','status','actual'])<>(prev.snapshot-ARRAY['version','status','actual'])
              OR NOT (NEW.command_body @> jsonb_build_object('quoteVersion',NEW.quote_version,'totalShippingFee',NEW.actual_total,'evidenceRef','delivery-evidence:'||NEW.evidence_id))
              OR NOT (NEW.snapshot->'actual' @> (NEW.command_body || jsonb_build_object('actor',jsonb_build_object('id',NEW.actor_user_id,'role',NEW.actor_role),
                'contentFingerprint',NEW.content_fingerprint,'approvedCeilingTotal',NEW.shipping_total,'customerShippingShare',NEW.actual_customer_share,'technicianShippingShare',NEW.actual_technician_share)))
              THEN RAISE EXCEPTION 'Invalid delivery actual transition'; END IF;
          END IF;
        END IF;
        IF NEW.kind<>'CONSENT' AND NOT EXISTS (SELECT 1 FROM delivery_evidence_records e WHERE e.id=NEW.evidence_id
          AND e.part_request_id=s.part_request_id AND e.service_order_id=s.service_order_id AND e.uploader_user_id=s.responsible_service_manager_id
          AND e.quote_version=NEW.quote_version AND e.purpose=CASE WHEN NEW.kind='RECORD_ACTUAL' THEN 'ACTUAL' ELSE 'QUOTE' END)
          THEN RAISE EXCEPTION 'Delivery evidence binding mismatch'; END IF;
        IF NEW.snapshot->>'status' IS DISTINCT FROM expected_status
          THEN RAISE EXCEPTION 'Delivery status mismatch'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER delivery_command_guard BEFORE INSERT ON delivery_consent_commands FOR EACH ROW EXECUTE FUNCTION delivery_command_guard();

      CREATE FUNCTION delivery_consent_journal_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s delivery_consent_sessions; head delivery_consent_commands; n bigint;
      BEGIN
        SELECT * INTO STRICT s FROM delivery_consent_sessions WHERE part_request_id=NEW.part_request_id;
        SELECT count(*) INTO n FROM delivery_consent_commands WHERE part_request_id=s.part_request_id;
        SELECT * INTO head FROM delivery_consent_commands WHERE part_request_id=s.part_request_id AND result_version=s.version;
        IF n<>s.version OR head.command_id IS NULL OR head.snapshot<>s.projection THEN RAISE EXCEPTION 'Incomplete delivery command journal'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER delivery_session_complete AFTER INSERT OR UPDATE ON delivery_consent_sessions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION delivery_consent_journal_complete();
      CREATE CONSTRAINT TRIGGER delivery_command_complete AFTER INSERT ON delivery_consent_commands
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION delivery_consent_journal_complete();

      ALTER TABLE delivery_consent_sessions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE delivery_consent_commands ENABLE ROW LEVEL SECURITY;
      ALTER TABLE delivery_evidence_records ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON delivery_consent_sessions, delivery_consent_commands, delivery_evidence_records FROM PUBLIC;
      REVOKE ALL ON FUNCTION delivery_consent_scope_matches(delivery_consent_sessions), delivery_consent_session_guard(),
        delivery_evidence_scope_guard(), delivery_consent_append_only(), delivery_command_guard(), delivery_consent_journal_complete() FROM PUBLIC;
      DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
          EXECUTE format('REVOKE ALL ON delivery_consent_sessions, delivery_consent_commands, delivery_evidence_records FROM %I',r);
          EXECUTE format('REVOKE ALL ON FUNCTION delivery_consent_scope_matches(delivery_consent_sessions), delivery_consent_session_guard(), delivery_evidence_scope_guard(), delivery_consent_append_only(), delivery_command_guard(), delivery_consent_journal_complete() FROM %I',r);
        END IF;
      END LOOP; END $$;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    // Empty-schema reversal only. Never delete receipts/evidence to make downgrade succeed.
    await q.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM delivery_consent_sessions) OR EXISTS (SELECT 1 FROM delivery_consent_commands)
      OR EXISTS (SELECT 1 FROM delivery_evidence_records) THEN RAISE EXCEPTION 'Refusing to discard delivery consent history'; END IF; END $$;
      DROP TRIGGER delivery_command_complete ON delivery_consent_commands;
      DROP TRIGGER delivery_session_complete ON delivery_consent_sessions;
      DROP FUNCTION delivery_consent_journal_complete();
      DROP TRIGGER delivery_command_guard ON delivery_consent_commands;
      DROP FUNCTION delivery_command_guard();
      DROP TRIGGER delivery_evidence_scope ON delivery_evidence_records;
      DROP FUNCTION delivery_evidence_scope_guard();
      DROP TRIGGER delivery_session_guard ON delivery_consent_sessions;
      DROP FUNCTION delivery_consent_session_guard();
      DROP FUNCTION delivery_consent_scope_matches(delivery_consent_sessions);
      DROP TABLE delivery_consent_commands;
      DROP TABLE delivery_evidence_records;
      DROP TABLE delivery_consent_sessions;
      DROP FUNCTION delivery_consent_append_only();`);
  }
}
