import { MigrationInterface, QueryRunner } from 'typeorm';

/** Positive fee negotiation is NOT an accounting commitment or spending authorization.
 * No historical rewrite, financial cutover, L/C/D default, payable or payout is introduced. */
export class DeliveryConditionalFeeTerms1793466000010 implements MigrationInterface {
  name = 'DeliveryConditionalFeeTerms1793466000010';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE delivery_fee_terms (
        part_request_id uuid NOT NULL REFERENCES warehouse_delivery_cohorts(part_request_id),
        service_order_id uuid NOT NULL REFERENCES service_orders(id),
        command_id uuid NOT NULL, expected_version integer NOT NULL CONSTRAINT ck_w3_fee_expected_version CHECK(expected_version BETWEEN 0 AND 2147483646),
        result_version integer NOT NULL CONSTRAINT ck_w3_fee_result_version CHECK(result_version=expected_version+1),
        actor_user_id uuid NOT NULL REFERENCES users(id), actor_role varchar(32) NOT NULL,
        kind varchar(24) NOT NULL CONSTRAINT ck_w3_fee_kind CHECK(kind IN ('PROPOSE','CONSENT','RECORD_ACTUAL')),
        command_body jsonb NOT NULL, source_snapshot jsonb NOT NULL, state jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(part_request_id,result_version), UNIQUE(part_request_id,command_id)
      );
      CREATE INDEX ix_delivery_fee_terms_order ON delivery_fee_terms(service_order_id,part_request_id,result_version DESC);

      CREATE FUNCTION w3_fee_source_snapshot(request_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET timezone='UTC' AS $$
        SELECT jsonb_build_object('cost',to_jsonb(ac),'assignmentId',a.id,'customerId',b.customer_id,
          'requestItems',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM part_request_items i WHERE i.part_request_id=r.id),
          'sourceItems',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM additional_cost_items i WHERE i.request_id=ac.id))
        FROM warehouse_delivery_cohorts c JOIN part_requests r ON r.id=c.part_request_id
        JOIN service_orders o ON o.id=r.service_order_id JOIN bookings b ON b.id=o.booking_id
        JOIN additional_cost_requests ac ON ac.id=r.additional_cost_id
        JOIN technician_assignments a ON a.service_order_id=o.id AND a.technician_id=r.technician_id AND a.is_active
        JOIN users t ON t.id=r.technician_id JOIN users cu ON cu.id=b.customer_id
        WHERE r.id=request_id AND r.request_type::text='additional' AND r.fulfillment_method::text='delivery'
          AND c.service_order_id=o.id AND c.technician_id=r.technician_id AND r.quotation_id IS NULL
          AND r.status::text='requested' AND r.received_at IS NULL AND r.qr_token IS NULL
          AND o.status::text IN ('accepted','en_route','under_repair') AND o.completion_requested_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM invoices WHERE service_order_id=o.id)
          AND ac.status::text='approved' AND ac.decided_at IS NOT NULL AND ac.service_order_id=o.id
          AND ac.technician_id=r.technician_id AND ac.decided_by_customer_id=b.customer_id AND ac.fulfillment_method::text='delivery'
          AND ac.shipping_fee BETWEEN 1 AND 9007199254740991 AND r.shipping_fee=ac.shipping_fee
          AND t.role::text='technician' AND t.is_active AND t.status::text='active'
          AND cu.role::text='customer' AND cu.is_active AND cu.status::text='active'
          AND EXISTS(SELECT 1 FROM part_request_items WHERE part_request_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM part_request_items WHERE part_request_id=r.id
            AND (part_source IS NULL OR part_source::text<>'fixhome' OR part_catalog_id IS NULL OR quantity IS NULL OR quantity<=0))
          AND w3_live_quantities(r.id)=(SELECT coalesce(jsonb_agg(jsonb_build_object('partId',part_catalog_id,'quantity',qty) ORDER BY part_catalog_id),'[]'::jsonb)
            FROM (SELECT part_catalog_id,sum(quantity)::integer qty FROM additional_cost_items WHERE request_id=ac.id
              AND type::text='parts_equipment' AND part_source::text='fixhome' GROUP BY part_catalog_id) x)
      $$;

      CREATE FUNCTION w3_fee_terms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE r part_requests; prev delivery_fee_terms; src jsonb; st jsonb; quote jsonb;
        b jsonb; keys text[]; warehouse uuid; sm uuid; e delivery_operation_evidence;
        fee numeric; customer numeric; tech numeric; qv integer; current_version integer;
      BEGIN
        -- Same serialization root as operational delivery and its other writers.
        PERFORM 1 FROM service_orders WHERE id=(SELECT service_order_id FROM part_requests WHERE id=NEW.part_request_id) FOR UPDATE;
        PERFORM 1 FROM users WHERE id=(SELECT technician_id FROM part_requests WHERE id=NEW.part_request_id) FOR UPDATE;
        SELECT * INTO STRICT r FROM part_requests WHERE id=NEW.part_request_id FOR UPDATE;
        PERFORM 1 FROM warehouse_delivery_cohorts WHERE part_request_id=r.id FOR UPDATE;
        PERFORM 1 FROM additional_cost_requests WHERE id=r.additional_cost_id FOR SHARE;
        PERFORM 1 FROM additional_cost_items WHERE request_id=r.additional_cost_id ORDER BY id FOR SHARE;
        PERFORM 1 FROM technician_assignments WHERE service_order_id=r.service_order_id AND is_active FOR SHARE;
        PERFORM 1 FROM users WHERE id=NEW.actor_user_id AND role::text=NEW.actor_role AND is_active AND status::text='active' FOR SHARE;
        IF NOT FOUND OR NEW.service_order_id<>r.service_order_id THEN RAISE EXCEPTION 'DELIVERY_TERMS_ACTOR_DENIED'; END IF;
        src:=w3_fee_source_snapshot(r.id);
        IF src IS NULL OR EXISTS(SELECT 1 FROM delivery_shipping_proposals WHERE part_request_id=r.id)
          OR EXISTS(SELECT 1 FROM warehouse_delivery_events WHERE part_request_id=r.id
            AND snapshot->>'status' NOT IN ('INELIGIBLE','PENDING_ASSISTANCE','RELEASED'))
          THEN RAISE EXCEPTION 'DELIVERY_TERMS_SOURCE_REQUIRED'; END IF;
        SELECT * INTO prev FROM delivery_fee_terms WHERE part_request_id=r.id ORDER BY result_version DESC LIMIT 1;
        current_version:=coalesce(prev.result_version,0);
        IF NEW.expected_version<>current_version THEN RAISE EXCEPTION 'DELIVERY_TERMS_CAS_CONFLICT'; END IF;
        b:=NEW.command_body;
        keys:=CASE NEW.kind WHEN 'PROPOSE' THEN ARRAY['commandId','expectedVersion','warehouseId','evidenceId','courierReference','totalShippingFee']
          WHEN 'CONSENT' THEN ARRAY['commandId','expectedVersion','quoteVersion','quoteFingerprint','totalShippingFee','shippingShare','accepted']
          ELSE ARRAY['commandId','expectedVersion','quoteVersion','totalShippingFee','evidenceId'] END;
        IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR NOT (b ?& keys) OR b-keys<>'{}'::jsonb
          OR b->>'commandId' IS DISTINCT FROM NEW.command_id::text OR b->'expectedVersion' IS DISTINCT FROM to_jsonb(NEW.expected_version)
          OR jsonb_typeof(b->'totalShippingFee') IS DISTINCT FROM 'number'
          OR NOT coalesce(b->>'totalShippingFee' ~ '^(0|[1-9][0-9]*)$',false)
          THEN RAISE EXCEPTION 'DELIVERY_TERMS_INVALID_COMMAND'; END IF;
        fee:=(b->>'totalShippingFee')::numeric;
        IF fee>9007199254740991 THEN RAISE EXCEPTION 'DELIVERY_TERMS_INVALID_AMOUNT'; END IF;
        IF NEW.kind='PROPOSE' THEN
          IF prev.state->'actual' IS NOT NULL AND prev.state->'actual'<>'null'::jsonb
            THEN RAISE EXCEPTION 'DELIVERY_TERMS_ACTUAL_RECONCILIATION_REQUIRED'; END IF;
          IF NEW.actor_role<>'service_manager' OR fee<1 OR fee>(src#>>'{cost,shipping_fee}')::numeric
            THEN RAISE EXCEPTION 'DELIVERY_TERMS_APPROVED_CEILING_REQUIRED'; END IF;
          warehouse:=(b->>'warehouseId')::uuid; sm:=NEW.actor_user_id;
          qv:=coalesce((prev.state#>>'{quote,quoteVersion}')::integer,0)+1;
          customer:=floor((7*fee+5)/10); tech:=fee-customer;
          SELECT * INTO STRICT e FROM delivery_operation_evidence WHERE id=(b->>'evidenceId')::uuid;
          IF e.part_request_id<>r.id OR e.service_order_id<>r.service_order_id OR e.warehouse_id<>warehouse OR e.uploader_user_id<>sm
            OR e.purpose<>'QUOTE' OR e.quote_version<>qv OR NOT coalesce(b->>'courierReference' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$',false)
            THEN RAISE EXCEPTION 'DELIVERY_TERMS_EVIDENCE_REQUIRED'; END IF;
          quote:=jsonb_build_object('quoteVersion',qv,'policyVersion','W3_70_30_V1','totalShippingFee',fee,
            'customerShippingShare',customer,'technicianShippingShare',tech,'warehouseId',warehouse,
            'responsibleUserId',sm,'assignmentId',src->>'assignmentId','evidenceId',e.id,'courierReference',b->>'courierReference');
          -- Fingerprint binds exact source as well as quote; it is content identity, not a payment signature.
          quote:=quote||jsonb_build_object('fingerprint',encode(sha256(convert_to((jsonb_build_array(r.id,src,quote))::text,'UTF8')),'hex'));
          st:=jsonb_build_object('quote',quote,'customerConsented',false,'technicianConsented',false,'actual',null);
          IF EXISTS(SELECT 1 FROM delivery_fee_terms f JOIN part_requests other ON other.id=f.part_request_id
            WHERE f.part_request_id<>r.id AND other.additional_cost_id=r.additional_cost_id)
            THEN RAISE EXCEPTION 'DELIVERY_TERMS_SOURCE_ALREADY_BOUND'; END IF;
        ELSE
          IF current_version=0 OR src IS DISTINCT FROM prev.source_snapshot THEN RAISE EXCEPTION 'DELIVERY_TERMS_SOURCE_CHANGED'; END IF;
          st:=prev.state; quote:=st->'quote'; warehouse:=(quote->>'warehouseId')::uuid; sm:=(quote->>'responsibleUserId')::uuid;
          qv:=(quote->>'quoteVersion')::integer;
          IF b->'quoteVersion' IS DISTINCT FROM to_jsonb(qv) THEN RAISE EXCEPTION 'DELIVERY_TERMS_QUOTE_MISMATCH'; END IF;
          IF NEW.kind='CONSENT' THEN
            IF NOT ((NEW.actor_role='customer' AND NEW.actor_user_id=(src->>'customerId')::uuid)
              OR (NEW.actor_role='technician' AND NEW.actor_user_id=r.technician_id))
              THEN RAISE EXCEPTION 'DELIVERY_TERMS_ACTOR_DENIED'; END IF;
            IF b->'accepted' IS DISTINCT FROM 'true'::jsonb OR b->>'quoteFingerprint' IS DISTINCT FROM quote->>'fingerprint'
              OR b->'totalShippingFee' IS DISTINCT FROM quote->'totalShippingFee'
              OR b->'shippingShare' IS DISTINCT FROM quote->(CASE NEW.actor_role WHEN 'customer' THEN 'customerShippingShare' ELSE 'technicianShippingShare' END)
              OR (st->>(CASE NEW.actor_role WHEN 'customer' THEN 'customerConsented' ELSE 'technicianConsented' END))::boolean
              THEN RAISE EXCEPTION 'DELIVERY_TERMS_EXPLICIT_CONSENT_REQUIRED'; END IF;
            st:=st||jsonb_build_object(CASE NEW.actor_role WHEN 'customer' THEN 'customerConsented' ELSE 'technicianConsented' END,true);
          ELSE
            IF NEW.actor_role<>'service_manager' OR NEW.actor_user_id<>sm OR st->'customerConsented'<>'true'::jsonb
              OR st->'technicianConsented'<>'true'::jsonb OR st->'actual'<>'null'::jsonb
              OR fee>(quote->>'totalShippingFee')::numeric THEN RAISE EXCEPTION 'DELIVERY_TERMS_RENEWED_CONSENT_REQUIRED'; END IF;
            SELECT * INTO STRICT e FROM delivery_operation_evidence WHERE id=(b->>'evidenceId')::uuid;
            IF e.part_request_id<>r.id OR e.warehouse_id<>warehouse OR e.uploader_user_id<>sm OR e.purpose<>'ACTUAL' OR e.quote_version<>qv
              OR e.content_digest=(SELECT content_digest FROM delivery_operation_evidence WHERE id=(quote->>'evidenceId')::uuid)
              THEN RAISE EXCEPTION 'DELIVERY_TERMS_DISTINCT_ACTUAL_EVIDENCE_REQUIRED'; END IF;
            customer:=floor((7*fee+5)/10);
            st:=st||jsonb_build_object('actual',jsonb_build_object('totalShippingFee',fee,'customerShippingShare',customer,
              'technicianShippingShare',fee-customer,'quoteVersion',qv,'evidenceId',e.id,'verification','RECORDED_NOT_EXTERNALLY_VERIFIED'));
          END IF;
        END IF;
        PERFORM 1 FROM warehouses w JOIN users u ON u.id=w.responsible_user_id WHERE w.id=warehouse AND w.status='active'
          AND u.id=sm AND u.role::text='service_manager' AND u.is_active AND u.status::text='active' FOR SHARE OF w,u;
        IF NOT FOUND THEN RAISE EXCEPTION 'DELIVERY_TERMS_WAREHOUSE_AUTHORITY_CHANGED'; END IF;
        NEW.result_version:=NEW.expected_version+1; NEW.source_snapshot:=src;
        NEW.state:=st||jsonb_build_object('version',NEW.result_version,'financialExecution','BLOCKED','scope','CONDITIONAL_TERMS_ONLY',
          'laborBudget',null,'aggregateBudgetVerified',false,'paymentVerified',false);
        NEW.created_at:=now(); RETURN NEW;
      END $$;
      CREATE TRIGGER w3_fee_terms_guard BEFORE INSERT ON delivery_fee_terms FOR EACH ROW EXECUTE FUNCTION w3_fee_terms_guard();
      CREATE TRIGGER w3_fee_terms_immutable BEFORE UPDATE OR DELETE ON delivery_fee_terms FOR EACH ROW EXECUTE FUNCTION protect_w3_physical_history();
      CREATE TRIGGER w3_fee_terms_no_truncate BEFORE TRUNCATE ON delivery_fee_terms FOR EACH STATEMENT EXECUTE FUNCTION protect_w3_physical_history();
      CREATE UNIQUE INDEX ux_w3_fee_terms_audit ON audit_logs(resource_id,("after"->>'commandId')) WHERE resource_type='delivery_fee_terms';
      CREATE FUNCTION w3_fee_terms_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM audit_logs a WHERE a.resource_type='delivery_fee_terms' AND a.resource_id=NEW.part_request_id::text
          AND a.actor_user_id=NEW.actor_user_id AND a.actor_role=NEW.actor_role AND a.action='DELIVERY_FEE_TERMS_'||NEW.kind
          AND a."after"=jsonb_build_object('commandId',NEW.command_id,'version',NEW.result_version,'financialExecution','BLOCKED')
          AND a.xmin::text::bigint=txid_current()%4294967296)
          THEN RAISE EXCEPTION 'DELIVERY_TERMS_STRICT_AUDIT_REQUIRED'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER w3_fee_terms_complete AFTER INSERT ON delivery_fee_terms
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w3_fee_terms_complete();
      CREATE FUNCTION w3_fee_audit_protect() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' THEN
          IF EXISTS(SELECT 1 FROM delivery_fee_terms) THEN RAISE EXCEPTION 'Conditional terms audit is immutable'; END IF;
          RETURN NULL;
        END IF;
        IF OLD.resource_type='delivery_fee_terms' OR (TG_OP='UPDATE' AND NEW.resource_type='delivery_fee_terms')
          THEN RAISE EXCEPTION 'Conditional terms audit is immutable'; END IF;
        RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
      END $$;
      CREATE TRIGGER w3_fee_audit_protect BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION w3_fee_audit_protect();
      CREATE TRIGGER w3_fee_audit_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION w3_fee_audit_protect();
      ALTER TABLE delivery_fee_terms ENABLE ROW LEVEL SECURITY; REVOKE ALL ON delivery_fee_terms FROM PUBLIC;
      DO $$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON delivery_fee_terms FROM %I',role_name); END IF;
      END LOOP; END $$;

      -- Permit uploaded ACTUAL bytes for conditional terms; physical admission still uses the unchanged zero-fee guard.
      ALTER FUNCTION w3_live_evidence_guard() RENAME TO w3_live_evidence_guard_0008;
      DROP TRIGGER w3_live_evidence_guard ON delivery_operation_evidence;
      CREATE FUNCTION w3_live_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM part_requests r JOIN service_orders o ON o.id=r.service_order_id
          JOIN technician_assignments a ON a.service_order_id=o.id AND a.technician_id=r.technician_id AND a.is_active
          JOIN warehouses w ON w.id=NEW.warehouse_id JOIN users u ON u.id=NEW.uploader_user_id
          WHERE r.id=NEW.part_request_id AND o.id=NEW.service_order_id AND r.status::text='requested'
          AND o.status::text IN ('accepted','en_route','under_repair') AND o.completion_requested_at IS NULL
          AND u.is_active AND u.status::text='active' AND ((NEW.purpose='TECHNICIAN_RECEIPT' AND u.role::text='technician' AND u.id=r.technician_id)
          OR (NEW.purpose<>'TECHNICIAN_RECEIPT' AND u.role::text='service_manager' AND u.id=w.responsible_user_id)))
          THEN RAISE EXCEPTION 'Delivery evidence actor/scope mismatch'; END IF;
        IF NEW.purpose<>'QUOTE' AND NOT EXISTS(SELECT 1 FROM delivery_shipping_proposals p
          WHERE p.part_request_id=NEW.part_request_id AND p.quote_version=NEW.quote_version AND p.warehouse_id=NEW.warehouse_id)
          AND NOT (NEW.purpose='ACTUAL' AND EXISTS(SELECT 1 FROM delivery_fee_terms f WHERE f.part_request_id=NEW.part_request_id
            AND f.result_version=(SELECT max(result_version) FROM delivery_fee_terms WHERE part_request_id=NEW.part_request_id)
            AND (f.state#>>'{quote,quoteVersion}')::integer=NEW.quote_version AND (f.state#>>'{quote,warehouseId}')::uuid=NEW.warehouse_id
            AND (f.state#>>'{quote,responsibleUserId}')::uuid=NEW.uploader_user_id))
          THEN RAISE EXCEPTION 'Delivery evidence warehouse/proposal mismatch'; END IF;
        NEW.created_at:=now(); RETURN NEW;
      END $$;
      CREATE TRIGGER w3_live_evidence_guard BEFORE INSERT ON delivery_operation_evidence FOR EACH ROW EXECUTE FUNCTION w3_live_evidence_guard();
      REVOKE ALL ON FUNCTION w3_fee_source_snapshot(uuid),w3_fee_terms_guard(),w3_live_evidence_guard(),w3_fee_terms_complete(),w3_fee_audit_protect() FROM PUBLIC;
      DO $$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
          EXECUTE format('REVOKE ALL ON FUNCTION w3_fee_source_snapshot(uuid),w3_fee_terms_guard(),w3_live_evidence_guard(),w3_fee_terms_complete(),w3_fee_audit_protect() FROM %I',role_name);
        END IF;
      END LOOP; END $$;
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`LOCK TABLE delivery_fee_terms IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM delivery_fee_terms) THEN RAISE EXCEPTION 'Refusing to discard conditional delivery terms'; END IF; END $$;
      DROP TRIGGER w3_live_evidence_guard ON delivery_operation_evidence;
      DROP FUNCTION w3_live_evidence_guard();
      ALTER FUNCTION w3_live_evidence_guard_0008() RENAME TO w3_live_evidence_guard;
      CREATE TRIGGER w3_live_evidence_guard BEFORE INSERT ON delivery_operation_evidence FOR EACH ROW EXECUTE FUNCTION w3_live_evidence_guard();
      DROP TRIGGER w3_fee_audit_protect ON audit_logs;
      DROP TRIGGER w3_fee_audit_no_truncate ON audit_logs;
      DROP INDEX ux_w3_fee_terms_audit;
      DROP TABLE delivery_fee_terms;
      DROP FUNCTION w3_fee_terms_guard(),w3_fee_source_snapshot(uuid),w3_fee_terms_complete(),w3_fee_audit_protect();`);
  }
}
