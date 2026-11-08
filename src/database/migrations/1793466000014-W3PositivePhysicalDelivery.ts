import { MigrationInterface, QueryRunner } from 'typeorm';

/** Narrow terms-to-physical bridge. Invoice/payment/legacy projection gates remain closed. */
export class W3PositivePhysicalDelivery1793466000014 implements MigrationInterface {
  name = 'W3PositivePhysicalDelivery1793466000014';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE warehouse_delivery_events ADD COLUMN fee_terms_version integer,
        ADD CONSTRAINT fk_w3_physical_fee_terms FOREIGN KEY(part_request_id,fee_terms_version)
          REFERENCES delivery_fee_terms(part_request_id,result_version);

      CREATE FUNCTION w3_positive_physical_terms(target_request_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE r part_requests; f delivery_fee_terms; sibling delivery_fee_terms; quote jsonb; actual jsonb;
        snap w3_order_commission_snapshots; committed numeric:=0; fee numeric; customer numeric;
      BEGIN
        PERFORM 1 FROM service_orders WHERE id=(SELECT service_order_id FROM part_requests WHERE id=target_request_id) FOR UPDATE;
        PERFORM 1 FROM users WHERE id=(SELECT technician_id FROM part_requests WHERE id=target_request_id) FOR UPDATE;
        SELECT * INTO STRICT r FROM part_requests WHERE id=target_request_id FOR UPDATE;
        PERFORM 1 FROM warehouse_delivery_cohorts WHERE part_request_id=target_request_id FOR UPDATE;
        PERFORM 1 FROM technician_assignments WHERE service_order_id=r.service_order_id ORDER BY id FOR SHARE;
        PERFORM 1 FROM users WHERE id IN (r.technician_id,(SELECT customer_id FROM bookings WHERE id=(SELECT booking_id FROM service_orders WHERE id=r.service_order_id))) ORDER BY id FOR SHARE;
        SELECT * INTO STRICT f FROM delivery_fee_terms WHERE part_request_id=target_request_id ORDER BY result_version DESC LIMIT 1;
        quote:=f.state->'quote'; actual:=f.state->'actual';
        PERFORM 1 FROM warehouses w JOIN users u ON u.id=w.responsible_user_id
          WHERE w.id=(quote->>'warehouseId')::uuid AND w.status='active' AND u.id=(quote->>'responsibleUserId')::uuid
          AND u.role::text='service_manager' AND u.is_active AND u.status::text='active' FOR SHARE OF w,u;
        IF NOT FOUND THEN RAISE EXCEPTION 'DELIVERY_TERMS_WAREHOUSE_AUTHORITY_CHANGED'; END IF;
        PERFORM 1 FROM system_configs WHERE key='commission.rate_bps' FOR SHARE;
        PERFORM 1 FROM bookings WHERE id=(SELECT booking_id FROM service_orders WHERE id=r.service_order_id) FOR SHARE;
        PERFORM 1 FROM quotations WHERE service_order_id=r.service_order_id ORDER BY id FOR UPDATE;
        PERFORM 1 FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE service_order_id=r.service_order_id) ORDER BY id FOR SHARE;
        PERFORM 1 FROM additional_cost_requests WHERE service_order_id=r.service_order_id ORDER BY id FOR UPDATE;
        PERFORM 1 FROM additional_cost_items WHERE request_id IN (SELECT id FROM additional_cost_requests WHERE service_order_id=r.service_order_id) ORDER BY id FOR SHARE;
        IF f.source_snapshot IS DISTINCT FROM w3_fee_source_snapshot(target_request_id)
          OR NOT w3_prequote_commission_current(r.service_order_id)
          OR quote->>'assignmentId' IS DISTINCT FROM f.source_snapshot->>'assignmentId'
          OR EXISTS(SELECT 1 FROM delivery_shipping_proposals WHERE part_request_id=target_request_id)
          THEN RAISE EXCEPTION 'DELIVERY_TERMS_SOURCE_CHANGED'; END IF;
        IF f.state->'customerConsented' IS DISTINCT FROM 'true'::jsonb
          OR f.state->'technicianConsented' IS DISTINCT FROM 'true'::jsonb
          OR actual IS NULL OR actual='null'::jsonb OR actual->'quoteVersion' IS DISTINCT FROM quote->'quoteVersion'
          THEN RAISE EXCEPTION 'DELIVERY_DUAL_CONSENT_AND_ACTUAL_REQUIRED'; END IF;
        fee:=(actual->>'totalShippingFee')::numeric; customer:=floor((7*fee+5)/10);
        IF fee IS NULL OR fee<0 OR fee<>trunc(fee) OR fee>(quote->>'totalShippingFee')::numeric
          OR fee>(f.source_snapshot#>>'{cost,shipping_fee}')::numeric
          OR actual->'customerShippingShare' IS DISTINCT FROM to_jsonb(customer)
          OR actual->'technicianShippingShare' IS DISTINCT FROM to_jsonb(fee-customer)
          OR NOT EXISTS(SELECT 1 FROM delivery_operation_evidence e WHERE e.id=(actual->>'evidenceId')::uuid
            AND e.part_request_id=target_request_id AND e.service_order_id=r.service_order_id AND e.purpose='ACTUAL'
            AND e.warehouse_id=(quote->>'warehouseId')::uuid AND e.uploader_user_id=(quote->>'responsibleUserId')::uuid
            AND e.quote_version=(quote->>'quoteVersion')::integer)
          THEN RAISE EXCEPTION 'DELIVERY_TERMS_ACTUAL_INVALID'; END IF;
        -- All unresolved positive cohorts must have canonical terms. Quotes reserve budget until actual;
        -- physical RELEASE/cancellation is not a financial commitment release.
        IF EXISTS(SELECT 1 FROM warehouse_delivery_cohorts c JOIN part_requests pr ON pr.id=c.part_request_id
          WHERE c.service_order_id=r.service_order_id AND pr.shipping_fee>0
          AND NOT EXISTS(SELECT 1 FROM delivery_fee_terms WHERE part_request_id=pr.id))
          THEN RAISE EXCEPTION 'DELIVERY_ORDER_BUDGET_COVERAGE_REQUIRED'; END IF;
        FOR sibling IN SELECT DISTINCT ON (part_request_id) * FROM delivery_fee_terms
          WHERE service_order_id=r.service_order_id ORDER BY part_request_id,result_version DESC LOOP
          IF sibling.source_snapshot IS DISTINCT FROM w3_fee_source_snapshot(sibling.part_request_id)
            THEN RAISE EXCEPTION 'DELIVERY_ORDER_BUDGET_SOURCE_CHANGED'; END IF;
          committed:=committed+coalesce((sibling.state#>>'{actual,technicianShippingShare}')::numeric,
            (sibling.state#>>'{quote,technicianShippingShare}')::numeric);
        END LOOP;
        SELECT * INTO STRICT snap FROM w3_order_commission_snapshots WHERE service_order_id=r.service_order_id;
        -- Demo operational budget is L-C-sum(t). Preparatory D is never approved income/deduction;
        -- an outstanding nonzero statement requires reconciliation before this narrow path.
        IF EXISTS(SELECT 1 FROM w3_deduction_preparations WHERE service_order_id=r.service_order_id AND recorded_total>0)
          OR committed IS NULL OR snap.labor_total-snap.commission_amount<committed
          THEN RAISE EXCEPTION 'DELIVERY_ORDER_LABOR_BUDGET_EXCEEDED'; END IF;
        RETURN f.state;
      END $$;
      CREATE OR REPLACE FUNCTION guard_w3_delivery_event() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE p delivery_shipping_proposals; s delivery_consent_sessions; prev warehouse_delivery_events;
        e delivery_operation_evidence; last_e jsonb; expected jsonb; previous_version integer; expected_role text; expected_actor uuid; terms jsonb; positive boolean;
      BEGIN
        PERFORM 1 FROM service_orders WHERE id=(SELECT service_order_id FROM part_requests WHERE id=NEW.part_request_id) FOR UPDATE;
        PERFORM 1 FROM users WHERE id=(SELECT technician_id FROM part_requests WHERE id=NEW.part_request_id) FOR UPDATE;
        PERFORM 1 FROM part_requests WHERE id=NEW.part_request_id FOR UPDATE;
        PERFORM 1 FROM warehouse_delivery_cohorts WHERE part_request_id=NEW.part_request_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Missing W3 cohort'; END IF;
        SELECT coalesce(max(result_version),0) INTO previous_version FROM warehouse_delivery_events WHERE part_request_id=NEW.part_request_id;
        IF NEW.expected_version<>previous_version THEN RAISE EXCEPTION 'W3 CAS conflict'; END IF;
        SELECT * INTO p FROM delivery_shipping_proposals WHERE part_request_id=NEW.part_request_id ORDER BY quote_version DESC LIMIT 1;
        positive:=EXISTS(SELECT 1 FROM delivery_fee_terms WHERE part_request_id=NEW.part_request_id);
        IF positive THEN
          SELECT * INTO prev FROM warehouse_delivery_events WHERE part_request_id=NEW.part_request_id AND result_version=previous_version;
          IF NEW.kind='RELEASE' THEN
            IF NEW.fee_terms_version IS DISTINCT FROM prev.fee_terms_version THEN RAISE EXCEPTION 'DELIVERY_TERMS_VERSION_MISMATCH'; END IF;
          ELSE
            terms:=w3_positive_physical_terms(NEW.part_request_id);
            IF NEW.fee_terms_version IS DISTINCT FROM (terms->>'version')::integer THEN RAISE EXCEPTION 'DELIVERY_TERMS_VERSION_MISMATCH'; END IF;
            IF previous_version>0 AND prev.snapshot->>'status' IN ('RESERVED','ISSUED_TO_COURIER','DISPATCH_RECORDED')
              AND prev.fee_terms_version IS DISTINCT FROM NEW.fee_terms_version THEN RAISE EXCEPTION 'DELIVERY_TERMS_VERSION_MISMATCH'; END IF;
          END IF;
          -- An in-memory adapter only: no legacy proposal or independent money source is inserted.
          SELECT (state#>>'{quote,warehouseId}')::uuid,(state#>>'{quote,responsibleUserId}')::uuid,
            (state#>>'{quote,assignmentId}')::uuid,(state#>>'{quote,quoteVersion}')::integer,state#>>'{quote,courierReference}'
            INTO p.warehouse_id,p.responsible_user_id,p.assignment_id,p.quote_version,p.courier_reference
            FROM delivery_fee_terms WHERE part_request_id=NEW.part_request_id AND result_version=NEW.fee_terms_version;
          IF NOT FOUND THEN RAISE EXCEPTION 'DELIVERY_TERMS_VERSION_MISMATCH'; END IF;
          p.part_request_id:=NEW.part_request_id;
        ELSIF NEW.fee_terms_version IS NOT NULL THEN RAISE EXCEPTION 'DELIVERY_TERMS_VERSION_MISMATCH';
        END IF;
        IF p.part_request_id IS NULL THEN
          IF NOT EXISTS(SELECT 1 FROM warehouse_delivery_cohorts c JOIN part_requests r ON r.id=c.part_request_id
            JOIN users u ON u.id=c.technician_id JOIN technician_assignments a ON a.service_order_id=c.service_order_id AND a.technician_id=u.id AND a.is_active
            WHERE c.part_request_id=NEW.part_request_id AND NEW.actor_role='technician' AND NEW.actor_user_id=u.id
            AND u.role::text='technician' AND u.is_active AND u.status::text='active' AND r.fulfillment_method::text='delivery'
            AND r.service_order_id=c.service_order_id AND r.technician_id=c.technician_id)
            OR NEW.kind<>'RESERVE' OR NOT coalesce(NEW.snapshot->>'status' IN ('INELIGIBLE','PENDING_ASSISTANCE'),false)
            OR NOT coalesce(NEW.snapshot->'quantities'='[]'::jsonb AND NEW.snapshot->'evidence'='[]'::jsonb
              AND NEW.snapshot->'warehouseId'='null'::jsonb AND NEW.snapshot->'responsibleUserId'='null'::jsonb AND NEW.snapshot->'courierReference'='null'::jsonb,false)
            OR NOT coalesce(NEW.snapshot->>'reason' IN ('LEGACY_REQUEST','NOT_DELIVERY','SCOPE_FROZEN','PARTS_SOURCE_UNVERIFIED','FIXHOME_ITEMS_REQUIRED','SHIPPING_APPROVAL_SOURCE_UNVERIFIED','DUAL_CONSENT_UNVERIFIED','NO_SINGLE_WAREHOUSE'),false)
            OR NEW.snapshot-ARRAY['status','reason','warehouseId','responsibleUserId','quantities','version','courierReference','evidence']<>'{}'::jsonb
            THEN RAISE EXCEPTION 'W3 physical activation closed'; END IF;
          RETURN NEW;
        END IF;
        SELECT * INTO prev FROM warehouse_delivery_events WHERE part_request_id=NEW.part_request_id AND result_version=previous_version;
        IF NEW.kind='RELEASE' THEN
          IF prev.snapshot->>'status' IS DISTINCT FROM 'RESERVED' OR NOT EXISTS(SELECT 1 FROM warehouses w JOIN users u ON u.id=w.responsible_user_id
            WHERE w.id=(prev.snapshot->>'warehouseId')::uuid AND NEW.actor_user_id=u.id AND NEW.actor_role='service_manager'
              AND u.role::text='service_manager' AND u.is_active AND u.status::text='active') THEN RAISE EXCEPTION 'Delivery release denied'; END IF;
          expected:=prev.snapshot||jsonb_build_object('version',NEW.result_version,'status','RELEASED');
        ELSE
          IF positive THEN
            SELECT technician_id INTO s.technician_user_id FROM part_requests WHERE id=NEW.part_request_id;
          ELSE
          SELECT * INTO STRICT s FROM delivery_consent_sessions WHERE part_request_id=NEW.part_request_id;
          IF NOT w3_live_source(p.part_request_id,p.warehouse_id,p.responsible_user_id,p.assignment_id) OR s.invalidated_at IS NOT NULL OR NOT delivery_consent_scope_matches(s)
            OR s.active_assignment_id<>p.assignment_id OR s.quote_version<>p.quote_version OR s.status<>'ACTUAL_RECORDED'
            OR NOT coalesce(s.projection#>'{quote,totalShippingFee}'='0'::jsonb AND s.projection#>'{actual,totalShippingFee}'='0'::jsonb
              AND s.projection->'customerConsent'<>'null'::jsonb AND s.projection->'technicianConsent'<>'null'::jsonb,false)
            THEN RAISE EXCEPTION 'Delivery consent/source/zero-spending gate'; END IF;
          END IF;
          expected_role:=CASE WHEN NEW.kind IN ('RESERVE','TECHNICIAN_RECEIPT') THEN 'technician' ELSE 'service_manager' END;
          expected_actor:=CASE WHEN expected_role='technician' THEN s.technician_user_id ELSE p.responsible_user_id END;
          IF NEW.actor_role<>expected_role OR NEW.actor_user_id<>expected_actor THEN RAISE EXCEPTION 'Delivery actor denied'; END IF;
          IF NEW.kind='RESERVE' THEN
            IF previous_version>0 AND prev.snapshot->>'status' NOT IN ('INELIGIBLE','PENDING_ASSISTANCE','RELEASED') THEN RAISE EXCEPTION 'Delivery already reserved'; END IF;
            IF NEW.snapshot->>'status'='PENDING_ASSISTANCE' THEN
              expected:=jsonb_build_object('version',NEW.result_version,'status','PENDING_ASSISTANCE','reason','NO_SINGLE_WAREHOUSE','warehouseId',null,'responsibleUserId',null,'quantities','[]'::jsonb,'courierReference',null,'evidence','[]'::jsonb);
            ELSE
              expected:=jsonb_build_object('version',NEW.result_version,'status','RESERVED','reason',null,'warehouseId',p.warehouse_id,
                'responsibleUserId',p.responsible_user_id,'quantities',w3_live_quantities(p.part_request_id),'courierReference',null,'evidence','[]'::jsonb);
            END IF;
          ELSE
            IF prev.snapshot->>'status' IS DISTINCT FROM (CASE NEW.kind WHEN 'ISSUE_TO_COURIER' THEN 'RESERVED' WHEN 'COURIER_DISPATCH' THEN 'ISSUED_TO_COURIER' WHEN 'TECHNICIAN_RECEIPT' THEN 'DISPATCH_RECORDED' END)
              THEN RAISE EXCEPTION 'Delivery transition denied'; END IF;
            last_e:=NEW.snapshot->'evidence'->-1;
            SELECT * INTO STRICT e FROM delivery_operation_evidence WHERE 'delivery-operation-evidence:'||id=last_e->>'evidenceRef';
            IF e.part_request_id<>NEW.part_request_id OR e.warehouse_id<>p.warehouse_id OR e.quote_version<>p.quote_version
              OR e.purpose<>NEW.kind OR e.uploader_user_id<>NEW.actor_user_id
              OR EXISTS(SELECT 1 FROM jsonb_array_elements(prev.snapshot->'evidence') j WHERE j->>'contentDigest'=e.content_digest)
              THEN RAISE EXCEPTION 'Delivery distinct evidence required'; END IF;
            expected:=prev.snapshot||jsonb_build_object('version',NEW.result_version,'status',CASE NEW.kind WHEN 'ISSUE_TO_COURIER' THEN 'ISSUED_TO_COURIER'
              WHEN 'COURIER_DISPATCH' THEN 'DISPATCH_RECORDED' ELSE 'TECHNICIAN_RECEIVED' END,'courierReference',p.courier_reference,
              'evidence',(prev.snapshot->'evidence')||jsonb_build_array(jsonb_build_object('kind',NEW.kind,'verification','RECORDED_NOT_EXTERNALLY_VERIFIED',
                'courierReference',p.courier_reference,'evidenceRef','delivery-operation-evidence:'||e.id,'contentDigest',e.content_digest)));
          END IF;
        END IF;
        IF NEW.snapshot IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Delivery physical snapshot mismatch'; END IF;
        NEW.created_at:=now(); RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION guard_w3_delivery_movement() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE e warehouse_delivery_events; own_reserved integer; qty integer; stock warehouse_stock;
      BEGIN
        SELECT * INTO STRICT e FROM warehouse_delivery_events WHERE part_request_id=NEW.part_request_id AND command_id=NEW.command_id;
        SELECT (j->>'quantity')::integer INTO qty FROM jsonb_array_elements(e.snapshot->'quantities') j WHERE (j->>'partId')::uuid=NEW.part_id;
        IF qty IS NULL OR NEW.kind<>e.kind OR NEW.warehouse_id<>(e.snapshot->>'warehouseId')::uuid OR NOT (EXISTS(SELECT 1 FROM delivery_shipping_proposals WHERE part_request_id=NEW.part_request_id)
          OR EXISTS(SELECT 1 FROM delivery_fee_terms f WHERE f.part_request_id=e.part_request_id AND f.result_version=e.fee_terms_version
            AND (e.kind='RELEASE' OR w3_positive_physical_terms(e.part_request_id)=f.state)))
          THEN RAISE EXCEPTION 'Delivery movement scope mismatch'; END IF;
        SELECT coalesce(sum(reservation_delta),0) INTO own_reserved FROM warehouse_delivery_movements WHERE part_request_id=NEW.part_request_id AND part_id=NEW.part_id;
        IF own_reserved<>(CASE NEW.kind WHEN 'RESERVE' THEN 0 ELSE qty END)
          OR NEW.reservation_delta<>(CASE NEW.kind WHEN 'RESERVE' THEN qty ELSE -qty END)
          OR NEW.delta<>(CASE NEW.kind WHEN 'ISSUE_TO_COURIER' THEN -qty ELSE 0 END)
          OR EXISTS(SELECT 1 FROM warehouse_delivery_movements WHERE part_request_id=NEW.part_request_id AND part_id=NEW.part_id AND kind='ISSUE_TO_COURIER')
          THEN RAISE EXCEPTION 'Delivery reservation attribution mismatch'; END IF;
        SELECT * INTO STRICT stock FROM warehouse_stock WHERE warehouse_id=NEW.warehouse_id AND part_id=NEW.part_id FOR UPDATE;
        IF stock.on_hand::bigint+NEW.delta<>NEW.on_hand_after OR stock.reserved::bigint+NEW.reservation_delta<>NEW.reserved_after
          OR NEW.on_hand_after<NEW.reserved_after OR NEW.reserved_after<0 THEN RAISE EXCEPTION 'Delivery stock balance mismatch'; END IF;
        UPDATE warehouse_stock SET on_hand=NEW.on_hand_after,reserved=NEW.reserved_after,version=version+1,updated_at=now()
          WHERE warehouse_id=NEW.warehouse_id AND part_id=NEW.part_id;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION w3_live_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE confirmed jsonb;
      BEGIN
        IF NEW.purpose IN ('ISSUE_TO_COURIER','COURIER_DISPATCH','TECHNICIAN_RECEIPT')
          AND EXISTS(SELECT 1 FROM delivery_fee_terms WHERE part_request_id=NEW.part_request_id) THEN
          confirmed:=w3_positive_physical_terms(NEW.part_request_id);
          IF confirmed#>>'{quote,warehouseId}' IS DISTINCT FROM NEW.warehouse_id::text
            OR (confirmed#>>'{quote,quoteVersion}')::integer IS DISTINCT FROM NEW.quote_version
            THEN RAISE EXCEPTION 'DELIVERY_EVIDENCE_WAREHOUSE_MISMATCH'; END IF;
        END IF;
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
          AND confirmed IS NULL AND NOT (NEW.purpose='ACTUAL' AND EXISTS(SELECT 1 FROM delivery_fee_terms f WHERE f.part_request_id=NEW.part_request_id
            AND f.result_version=(SELECT max(result_version) FROM delivery_fee_terms WHERE part_request_id=NEW.part_request_id)
            AND (f.state#>>'{quote,quoteVersion}')::integer=NEW.quote_version AND (f.state#>>'{quote,warehouseId}')::uuid=NEW.warehouse_id
            AND (f.state#>>'{quote,responsibleUserId}')::uuid=NEW.uploader_user_id))
          THEN RAISE EXCEPTION 'Delivery evidence warehouse/proposal mismatch'; END IF;
        NEW.created_at:=now(); RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION w3_live_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE source_id uuid;
      BEGIN
        IF TG_TABLE_NAME='additional_cost_requests' THEN source_id:=OLD.id;
        ELSE source_id:=CASE WHEN TG_OP='INSERT' THEN NEW.request_id ELSE OLD.request_id END; END IF;
        IF EXISTS(SELECT 1 FROM part_requests r WHERE
            (EXISTS(SELECT 1 FROM delivery_shipping_proposals p WHERE p.part_request_id=r.id)
            OR EXISTS(SELECT 1 FROM warehouse_delivery_events e WHERE e.part_request_id=r.id AND e.fee_terms_version IS NOT NULL
              AND e.snapshot->>'status' IN ('RESERVED','ISSUED_TO_COURIER','DISPATCH_RECORDED','TECHNICIAN_RECEIVED')))
            AND r.additional_cost_id=source_id)
          THEN RAISE EXCEPTION 'Delivery approved source snapshot is immutable'; END IF;
        IF TG_TABLE_NAME='additional_cost_items' AND TG_OP='UPDATE' THEN
          IF EXISTS(SELECT 1 FROM part_requests r WHERE
            (EXISTS(SELECT 1 FROM delivery_shipping_proposals p WHERE p.part_request_id=r.id)
            OR EXISTS(SELECT 1 FROM warehouse_delivery_events e WHERE e.part_request_id=r.id AND e.fee_terms_version IS NOT NULL
              AND e.snapshot->>'status' IN ('RESERVED','ISSUED_TO_COURIER','DISPATCH_RECORDED','TECHNICIAN_RECEIVED')))
            AND r.additional_cost_id=NEW.request_id)
            THEN RAISE EXCEPTION 'Delivery approved source snapshot is immutable'; END IF;
        END IF;
        RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
      END $$;
      REVOKE ALL ON FUNCTION w3_positive_physical_terms(uuid) FROM PUBLIC;
      DO $$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
          EXECUTE format('REVOKE ALL ON FUNCTION w3_positive_physical_terms(uuid) FROM %I',role_name);
        END IF;
      END LOOP; END $$;
    `);
  }
  async down(): Promise<void> {
    throw new Error(
      'Forward-only W3 positive physical bridge; preserve immutable history',
    );
  }
}
