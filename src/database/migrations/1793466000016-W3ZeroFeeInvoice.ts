import { MigrationInterface, QueryRunner } from 'typeorm';

/** Forward-only zero-route billing bridge. No backfill, synthetic terms or custody admission. */
export class W3ZeroFeeInvoice1793466000016 implements MigrationInterface {
  name = 'W3ZeroFeeInvoice1793466000016';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      -- Frozen zero-route proof uses immutable command/event journals, never the mutable
      -- session projection alone. Live scope is checked separately before invoice INSERT.
      CREATE FUNCTION w3_zero_receipt_provenance(request_id uuid,quote_ver integer,consent_ver integer,receipt_ver integer)
        RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS(SELECT 1 FROM delivery_shipping_proposals p
          JOIN delivery_consent_commands a ON a.part_request_id=p.part_request_id AND a.result_version=consent_ver
          JOIN warehouse_delivery_events e ON e.part_request_id=p.part_request_id AND e.result_version=receipt_ver
          JOIN warehouse_delivery_events issue ON issue.part_request_id=e.part_request_id AND issue.result_version=e.result_version-2
          JOIN warehouse_delivery_events reserve ON reserve.part_request_id=e.part_request_id AND reserve.result_version=e.result_version-3
          JOIN part_requests r ON r.id=p.part_request_id
          WHERE p.part_request_id=request_id AND p.quote_version=quote_ver
          AND NOT EXISTS(SELECT 1 FROM delivery_fee_terms WHERE part_request_id=request_id)
          AND a.kind='RECORD_ACTUAL' AND a.quote_version=p.quote_version AND a.actor_user_id=p.responsible_user_id
          AND a.actor_role='service_manager' AND a.shipping_total=0 AND a.customer_share=0 AND a.technician_share=0
          AND a.actual_total=0 AND a.actual_customer_share=0 AND a.actual_technician_share=0
          AND a.snapshot->>'status'='ACTUAL_RECORDED'
          AND a.snapshot#>>'{scope,partRequestId}'=r.id::text
          AND a.snapshot#>>'{scope,serviceOrderId}'=r.service_order_id::text
          AND a.snapshot#>>'{scope,technicianId}'=r.technician_id::text
          AND a.snapshot#>>'{scope,responsibleServiceManagerId}'=p.responsible_user_id::text
          AND EXISTS(SELECT 1 FROM delivery_operation_evidence ev WHERE ev.id=p.evidence_id
            AND ev.part_request_id=request_id AND ev.purpose='QUOTE' AND ev.quote_version=p.quote_version
            AND ev.warehouse_id=p.warehouse_id AND ev.uploader_user_id=p.responsible_user_id)
          AND EXISTS(SELECT 1 FROM delivery_operation_evidence ev WHERE ev.id=a.evidence_id
            AND ev.part_request_id=request_id AND ev.purpose='ACTUAL' AND ev.quote_version=p.quote_version
            AND ev.warehouse_id=p.warehouse_id AND ev.uploader_user_id=p.responsible_user_id)
          AND (SELECT count(*) FROM delivery_consent_commands c WHERE c.part_request_id=request_id
            AND c.quote_version=p.quote_version AND c.kind='CONSENT' AND c.quote_command_id=p.command_id
            AND c.result_version<a.result_version AND c.shipping_total=0 AND c.consent_share=0
            AND c.command_body->'accepted'='true'::jsonb
            AND c.command_body->>'quoteFingerprint'=a.snapshot#>>'{quote,fingerprint}'
            AND ((c.actor_role='customer' AND c.actor_user_id::text=a.snapshot#>>'{scope,customerId}')
              OR (c.actor_role='technician' AND c.actor_user_id=r.technician_id)))=2
          AND e.kind='TECHNICIAN_RECEIPT' AND e.fee_terms_version IS NULL
          AND e.actor_user_id=r.technician_id AND e.actor_role='technician'
          AND e.snapshot->>'status'='TECHNICIAN_RECEIVED' AND e.snapshot->>'warehouseId'=p.warehouse_id::text
          AND e.snapshot->>'responsibleUserId'=p.responsible_user_id::text
          AND e.snapshot->>'courierReference'=p.courier_reference
          AND issue.kind='ISSUE_TO_COURIER' AND reserve.kind='RESERVE'
          AND reserve.snapshot->>'status'='RESERVED' AND issue.fee_terms_version IS NULL AND reserve.fee_terms_version IS NULL
          AND issue.snapshot->'quantities'=e.snapshot->'quantities' AND reserve.snapshot->'quantities'=e.snapshot->'quantities'
          AND e.snapshot->'quantities'=w3_live_quantities(request_id) AND jsonb_array_length(e.snapshot->'quantities')>0
          AND jsonb_array_length(e.snapshot->'evidence')=3
          AND (SELECT count(DISTINCT ev.content_digest) FROM jsonb_array_elements(e.snapshot->'evidence') j
            JOIN delivery_operation_evidence ev ON 'delivery-operation-evidence:'||ev.id=j->>'evidenceRef'
            WHERE ev.part_request_id=request_id AND ev.warehouse_id=p.warehouse_id AND ev.quote_version=p.quote_version
              AND ev.purpose=j->>'kind' AND ev.content_digest=j->>'contentDigest'
              AND ((ev.purpose='TECHNICIAN_RECEIPT' AND ev.uploader_user_id=r.technician_id)
                OR (ev.purpose IN ('ISSUE_TO_COURIER','COURIER_DISPATCH') AND ev.uploader_user_id=p.responsible_user_id)))=3
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.snapshot->'quantities') j WHERE
            NOT EXISTS(SELECT 1 FROM warehouse_delivery_movements m WHERE m.part_request_id=request_id
              AND m.command_id=reserve.command_id AND m.kind='RESERVE' AND m.warehouse_id=p.warehouse_id
              AND m.part_id=(j->>'partId')::uuid AND m.delta=0 AND m.reservation_delta=(j->>'quantity')::integer)
            OR NOT EXISTS(SELECT 1 FROM warehouse_delivery_movements m WHERE m.part_request_id=request_id
              AND m.command_id=issue.command_id AND m.kind='ISSUE_TO_COURIER' AND m.warehouse_id=p.warehouse_id
              AND m.part_id=(j->>'partId')::uuid AND m.delta=-(j->>'quantity')::integer
              AND m.reservation_delta=-(j->>'quantity')::integer)))
      $$;
      CREATE OR REPLACE FUNCTION w3_received_request(request_id uuid) RETURNS boolean LANGUAGE plpgsql AS $$
      DECLARE e warehouse_delivery_events; f delivery_fee_terms; current_source jsonb; frozen_source jsonb; order_id uuid;
      BEGIN
        SELECT service_order_id INTO order_id FROM part_requests WHERE id=request_id;
        PERFORM 1 FROM service_orders WHERE id=order_id FOR UPDATE;
        IF EXISTS(SELECT 1 FROM invoices WHERE service_order_id=order_id AND w3_invoice_payment_verified(id)
          AND shipping_shipments @> jsonb_build_array(jsonb_build_object('partRequestId',request_id))) THEN RETURN true; END IF;
        PERFORM 1 FROM users WHERE id=(SELECT technician_id FROM part_requests WHERE id=request_id) FOR UPDATE;
        PERFORM 1 FROM part_requests WHERE id=request_id FOR UPDATE;
        PERFORM 1 FROM technician_assignments WHERE service_order_id=order_id ORDER BY id FOR SHARE;
        PERFORM 1 FROM bookings WHERE id=(SELECT booking_id FROM service_orders WHERE id=order_id) FOR SHARE;
        PERFORM 1 FROM system_configs WHERE key='commission.rate_bps' FOR SHARE;
        PERFORM 1 FROM quotations WHERE service_order_id=order_id ORDER BY id FOR UPDATE;
        PERFORM 1 FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE service_order_id=order_id) ORDER BY id FOR SHARE;
        PERFORM 1 FROM additional_cost_requests WHERE service_order_id=order_id ORDER BY id FOR UPDATE;
        PERFORM 1 FROM additional_cost_items aci WHERE aci.request_id IN (SELECT id FROM additional_cost_requests WHERE service_order_id=order_id) ORDER BY id FOR SHARE;
        SELECT * INTO e FROM warehouse_delivery_events WHERE part_request_id=request_id ORDER BY result_version DESC LIMIT 1;
        IF e.fee_terms_version IS NULL THEN
          PERFORM 1 FROM delivery_shipping_proposals p JOIN warehouses w ON w.id=p.warehouse_id
            JOIN users u ON u.id IN (p.responsible_user_id,(SELECT customer_id FROM bookings
              WHERE id=(SELECT booking_id FROM service_orders WHERE id=order_id)))
            WHERE p.part_request_id=request_id ORDER BY w.id,u.id FOR SHARE OF w,u;
          RETURN coalesce(e.kind='TECHNICIAN_RECEIPT' AND e.snapshot->>'status'='TECHNICIAN_RECEIVED'
            AND EXISTS(SELECT 1 FROM delivery_shipping_proposals p JOIN delivery_consent_sessions s USING(part_request_id)
              WHERE p.part_request_id=request_id AND p.quote_version=s.quote_version AND s.invalidated_at IS NULL
              AND s.status='ACTUAL_RECORDED' AND delivery_consent_scope_matches(s)
              AND w3_live_source(request_id,p.warehouse_id,p.responsible_user_id,p.assignment_id)
              AND w3_zero_receipt_provenance(request_id,p.quote_version,s.version,e.result_version))
            AND NOT EXISTS(SELECT 1 FROM w3_deduction_preparations WHERE service_order_id=order_id AND recorded_total>0),false);
        END IF;
        IF e.kind IS DISTINCT FROM 'TECHNICIAN_RECEIPT' OR e.snapshot->>'status' IS DISTINCT FROM 'TECHNICIAN_RECEIVED'
          OR e.fee_terms_version IS NULL THEN RETURN false; END IF;
        SELECT * INTO STRICT f FROM delivery_fee_terms WHERE part_request_id=request_id ORDER BY result_version DESC LIMIT 1;
        current_source:=w3_fee_source_snapshot(request_id); frozen_source:=f.source_snapshot;
        -- USED is the sole newly permitted mutation after physical receipt; all identity/quantity/price fields stay exact.
        current_source:=jsonb_set(current_source,'{requestItems}',(SELECT jsonb_agg(j-ARRAY['usage_status','updated_at'] ORDER BY j->>'id') FROM jsonb_array_elements(current_source->'requestItems') j));
        frozen_source:=jsonb_set(frozen_source,'{requestItems}',(SELECT jsonb_agg(j-ARRAY['usage_status','updated_at'] ORDER BY j->>'id') FROM jsonb_array_elements(frozen_source->'requestItems') j));
        PERFORM 1 FROM warehouses w JOIN users u ON u.id=w.responsible_user_id
          WHERE w.id=(f.state#>>'{quote,warehouseId}')::uuid AND w.status='active' AND u.id=(f.state#>>'{quote,responsibleUserId}')::uuid
          AND u.role::text='service_manager' AND u.is_active AND u.status::text='active' FOR SHARE OF w,u;
        RETURN FOUND AND current_source IS NOT NULL AND current_source=frozen_source
          AND EXISTS(SELECT 1 FROM w3_order_commission_snapshots snap
            WHERE snap.service_order_id=order_id AND f.commission_order_id=snap.service_order_id
              AND snap.labor_source=w3_approved_labor_source(order_id))
          AND e.fee_terms_version=f.result_version
          AND f.state->'customerConsented'='true'::jsonb AND f.state->'technicianConsented'='true'::jsonb
          AND f.state->'actual' IS NOT NULL AND f.state->'actual'<>'null'::jsonb
          AND NOT EXISTS(SELECT 1 FROM w3_deduction_preparations WHERE service_order_id=order_id AND recorded_total>0);
      END $$;

      CREATE OR REPLACE FUNCTION w3_invoice_shipping_source(order_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE r part_requests; f delivery_fee_terms; e warehouse_delivery_events; p delivery_shipping_proposals; s delivery_consent_sessions; result jsonb:='[]';
      BEGIN
        PERFORM 1 FROM service_orders WHERE id=order_id FOR UPDATE;
        IF NOT EXISTS(SELECT 1 FROM warehouse_delivery_cohorts WHERE service_order_id=order_id) THEN RETURN NULL; END IF;
        -- These subpaths retain their existing protected contracts. Refuse before collection.
        IF EXISTS(SELECT 1 FROM bookings b JOIN service_orders o ON o.booking_id=b.id WHERE o.id=order_id AND b.visit_group_id IS NOT NULL)
          OR EXISTS(SELECT 1 FROM part_custodies WHERE service_order_id=order_id)
          THEN RAISE EXCEPTION 'W3_GROUP_OR_CUSTODY_UNSUPPORTED'; END IF;
        IF EXISTS(SELECT 1 FROM part_requests pr WHERE pr.service_order_id=order_id AND pr.fulfillment_method::text='delivery'
          AND pr.shipping_fee>0 AND NOT EXISTS(SELECT 1 FROM warehouse_delivery_cohorts WHERE part_request_id=pr.id))
          THEN RAISE EXCEPTION 'W3_MIXED_SHIPPING_UNSUPPORTED'; END IF;
        FOR r IN SELECT pr.* FROM part_requests pr JOIN warehouse_delivery_cohorts c ON c.part_request_id=pr.id
          WHERE c.service_order_id=order_id ORDER BY pr.id FOR UPDATE OF pr LOOP
          IF r.status::text<>'requested' OR NOT w3_received_request(r.id)
            THEN RAISE EXCEPTION 'W3_RECEIPT_REQUIRED'; END IF;
          IF EXISTS(SELECT 1 FROM part_request_items WHERE part_request_id=r.id AND usage_status::text<>'used')
            THEN RAISE EXCEPTION 'W3_FULL_USED_PARTS_REQUIRED'; END IF;
          IF EXISTS(SELECT 1 FROM part_requests pr WHERE pr.additional_cost_id=r.additional_cost_id AND pr.id<>r.id AND pr.status::text<>'cancelled')
            THEN RAISE EXCEPTION 'W3_DUPLICATE_APPROVED_SOURCE'; END IF;
          SELECT * INTO STRICT e FROM warehouse_delivery_events WHERE part_request_id=r.id ORDER BY result_version DESC LIMIT 1;
          IF e.fee_terms_version IS NULL THEN
            SELECT * INTO STRICT s FROM delivery_consent_sessions WHERE part_request_id=r.id;
            SELECT * INTO STRICT p FROM delivery_shipping_proposals WHERE part_request_id=r.id AND quote_version=s.quote_version;
            result:=result||jsonb_build_array(jsonb_build_object('partRequestId',r.id,'additionalCostId',r.additional_cost_id,
              'termsVersion',null,'zeroQuoteVersion',p.quote_version,'consentVersion',s.version,'receiptVersion',e.result_version,
              'shippingPolicyVersion','W3_70_30_V1','shippingFee',0,'customerShippingShare',0,'technicianShippingShare',0));
            CONTINUE;
          END IF;
          SELECT * INTO STRICT f FROM delivery_fee_terms WHERE part_request_id=r.id ORDER BY result_version DESC LIMIT 1;
          result:=result||jsonb_build_array(jsonb_build_object('partRequestId',r.id,'additionalCostId',r.additional_cost_id,
            'termsVersion',f.result_version,'receiptVersion',e.result_version,'shippingPolicyVersion','W3_70_30_V1',
            'shippingFee',(f.state#>>'{actual,totalShippingFee}')::bigint,
            'customerShippingShare',(f.state#>>'{actual,customerShippingShare}')::bigint,
            'technicianShippingShare',(f.state#>>'{actual,technicianShippingShare}')::bigint));
        END LOOP;
        RETURN result;
      END $$;

      -- Zero-only orders never made a positive quote, so have no prequote C snapshot.
      -- Freeze their approved labor/current strict config in the invoice itself. Existing
      -- positive/mixed orders always retain the immutable prequote snapshot and drift gate.
      CREATE FUNCTION w3_invoice_commission_source(order_id uuid)
        RETURNS TABLE(labor_total bigint,rate_bps integer,commission_amount bigint) LANGUAGE plpgsql AS $$
      DECLARE snap w3_order_commission_snapshots; src jsonb; cfg system_configs; lines jsonb;
      BEGIN
        PERFORM 1 FROM service_orders WHERE id=order_id FOR UPDATE;
        lines:=w3_invoice_shipping_source(order_id);
        IF lines IS NULL THEN RAISE EXCEPTION 'W3_SOURCE_REQUIRED'; END IF;
        SELECT * INTO snap FROM w3_order_commission_snapshots WHERE service_order_id=order_id;
        IF FOUND THEN
          IF snap.labor_source IS DISTINCT FROM w3_approved_labor_source(order_id)
            THEN RAISE EXCEPTION 'W3_COMMISSION_LABOR_CHANGED'; END IF;
          RETURN QUERY SELECT snap.labor_total,snap.rate_bps,snap.commission_amount;
          RETURN;
        END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(lines) j WHERE j->'termsVersion' IS DISTINCT FROM 'null'::jsonb)
          OR EXISTS(SELECT 1 FROM delivery_fee_terms WHERE service_order_id=order_id)
          THEN RAISE EXCEPTION 'W3_COMMISSION_SNAPSHOT_REQUIRED'; END IF;
        -- Receipt verification above pins assignment, approved labor and config rows.
        SELECT * INTO STRICT cfg FROM system_configs WHERE key='commission.rate_bps' FOR SHARE;
        IF cfg.value_type<>'int' OR cfg.value !~ '^(0|[1-9][0-9]{0,4})$' OR cfg.value::integer>10000
          THEN RAISE EXCEPTION 'W3_COMMISSION_CONFIG_INVALID'; END IF;
        src:=w3_approved_labor_source(order_id);
        IF src IS NULL THEN RAISE EXCEPTION 'W3_COMMISSION_APPROVED_LABOR_REQUIRED'; END IF;
        RETURN QUERY SELECT (src->>'laborTotal')::numeric::bigint,cfg.value::integer,
          floor(((src->>'laborTotal')::numeric*cfg.value::integer+5000)/10000)::bigint;
      END $$;
      CREATE OR REPLACE FUNCTION w3_live_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE lines jsonb; snap record;
      BEGIN
        lines:=w3_invoice_shipping_source(NEW.service_order_id);
        IF lines IS NULL THEN
          IF NEW.shipping_policy_version<>'LEGACY_100_0' OR NEW.shipping_shipments IS NOT NULL THEN RAISE EXCEPTION 'W3_SOURCE_REQUIRED'; END IF;
          RETURN NEW;
        END IF;
        SELECT * INTO STRICT snap FROM w3_invoice_commission_source(NEW.service_order_id);
        IF NEW.shipping_policy_version<>'W3_70_30_V1' OR NEW.shipping_shipments IS DISTINCT FROM lines
          OR NEW.labor_total IS DISTINCT FROM snap.labor_total OR NEW.commission_amount IS DISTINCT FROM snap.commission_amount
          OR NEW.commission_base::text IS DISTINCT FROM 'LABOR'
          OR NEW.commission_rate_snapshot*10000 IS DISTINCT FROM snap.rate_bps::numeric
          OR NEW.labor_total-NEW.commission_amount-NEW.technician_shipping_share<0
          OR NEW.parts_total<>NEW.fixhome_parts_total+NEW.technician_parts_total
          OR NEW.grand_total<>NEW.labor_total+NEW.parts_total+NEW.technician_part_warranty_fee_total+NEW.customer_shipping_share
          OR EXISTS(SELECT 1 FROM invoices WHERE service_order_id=NEW.service_order_id)
          THEN RAISE EXCEPTION 'W3_INVOICE_SOURCE_MISMATCH'; END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION w3_invoice_payment_verified(invoice_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT coalesce((SELECT i.shipping_policy_version='W3_70_30_V1'
          AND w3_invoice_shipping_totals(i.shipping_shipments,i.shipping_fee,i.customer_shipping_share,i.technician_shipping_share)
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i.shipping_shipments) j WHERE NOT EXISTS(
            SELECT 1 FROM delivery_fee_terms f JOIN warehouse_delivery_events e ON e.part_request_id=f.part_request_id
            JOIN part_requests r ON r.id=f.part_request_id
            WHERE f.part_request_id=(j->>'partRequestId')::uuid AND f.service_order_id=i.service_order_id
            AND r.additional_cost_id=(j->>'additionalCostId')::uuid AND f.result_version=(j->>'termsVersion')::integer
            AND e.result_version=(j->>'receiptVersion')::integer AND e.fee_terms_version=f.result_version
            AND e.kind='TECHNICIAN_RECEIPT' AND e.snapshot->>'status'='TECHNICIAN_RECEIVED'
            AND f.state->'customerConsented'='true'::jsonb AND f.state->'technicianConsented'='true'::jsonb
            AND f.state#>'{actual,totalShippingFee}'=j->'shippingFee'
            AND f.state#>'{actual,customerShippingShare}'=j->'customerShippingShare'
            AND f.state#>'{actual,technicianShippingShare}'=j->'technicianShippingShare')
            AND NOT coalesce((j->'termsVersion'='null'::jsonb AND j->'shippingFee'='0'::jsonb
              AND j->'customerShippingShare'='0'::jsonb AND j->'technicianShippingShare'='0'::jsonb
              AND EXISTS(SELECT 1 FROM part_requests r JOIN warehouse_delivery_cohorts c ON c.part_request_id=r.id
                WHERE r.id=(j->>'partRequestId')::uuid AND c.service_order_id=i.service_order_id
                  AND r.additional_cost_id=(j->>'additionalCostId')::uuid)
              AND w3_zero_receipt_provenance((j->>'partRequestId')::uuid,(j->>'zeroQuoteVersion')::integer,
                (j->>'consentVersion')::integer,(j->>'receiptVersion')::integer)),false))
          FROM invoices i WHERE i.id=invoice_id),false)
      $$;
      -- CREATE OR REPLACE preserves ACLs, including explicit default role grants
      -- on the older invoice trigger function. Revoke all replaced entry points too.
      REVOKE ALL ON FUNCTION w3_zero_receipt_provenance(uuid,integer,integer,integer),w3_invoice_commission_source(uuid),
        w3_received_request(uuid),w3_invoice_shipping_source(uuid),w3_live_invoice_guard(),w3_invoice_payment_verified(uuid) FROM PUBLIC;
      DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
          EXECUTE format('REVOKE ALL ON FUNCTION w3_zero_receipt_provenance(uuid,integer,integer,integer),w3_invoice_commission_source(uuid),w3_received_request(uuid),w3_invoice_shipping_source(uuid),w3_live_invoice_guard(),w3_invoice_payment_verified(uuid) FROM %I',r);
        END IF;
      END LOOP; END $$;
    `);
  }
  async down(): Promise<void> {
    throw new Error('Forward-only W3 zero-fee invoice bridge; preserve financial history');
  }
}
