import { MigrationInterface, QueryRunner } from 'typeorm';

/** Forward-only, source-backed invoice cutover; no historical monetary rewrite. */
export class W3InvoicePaymentEnable1793466000015 implements MigrationInterface {
  name = 'W3InvoicePaymentEnable1793466000015';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE invoices ADD COLUMN shipping_shipments jsonb;
      CREATE FUNCTION w3_received_request(request_id uuid) RETURNS boolean LANGUAGE plpgsql AS $$
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
          AND w3_prequote_commission_current(order_id) AND e.fee_terms_version=f.result_version
          AND f.state->'customerConsented'='true'::jsonb AND f.state->'technicianConsented'='true'::jsonb
          AND f.state->'actual' IS NOT NULL AND f.state->'actual'<>'null'::jsonb
          AND NOT EXISTS(SELECT 1 FROM w3_deduction_preparations WHERE service_order_id=order_id AND recorded_total>0);
      END $$;

      CREATE FUNCTION w3_invoice_shipping_source(order_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE r part_requests; f delivery_fee_terms; e warehouse_delivery_events; result jsonb:='[]';
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
          SELECT * INTO STRICT f FROM delivery_fee_terms WHERE part_request_id=r.id ORDER BY result_version DESC LIMIT 1;
          SELECT * INTO STRICT e FROM warehouse_delivery_events WHERE part_request_id=r.id ORDER BY result_version DESC LIMIT 1;
          result:=result||jsonb_build_array(jsonb_build_object('partRequestId',r.id,'additionalCostId',r.additional_cost_id,
            'termsVersion',f.result_version,'receiptVersion',e.result_version,'shippingPolicyVersion','W3_70_30_V1',
            'shippingFee',(f.state#>>'{actual,totalShippingFee}')::bigint,
            'customerShippingShare',(f.state#>>'{actual,customerShippingShare}')::bigint,
            'technicianShippingShare',(f.state#>>'{actual,technicianShippingShare}')::bigint));
        END LOOP;
        RETURN result;
      END $$;

      CREATE FUNCTION w3_invoice_shipping_totals(lines jsonb,s bigint,c bigint,t bigint) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE j jsonb; total numeric:=0; customer numeric:=0; technician numeric:=0; fee numeric;
      BEGIN
        IF lines IS NULL OR jsonb_typeof(lines)<>'array' OR jsonb_array_length(lines)=0 THEN RETURN false; END IF;
        IF (SELECT count(DISTINCT x->>'partRequestId') FROM jsonb_array_elements(lines) x)<>jsonb_array_length(lines)
          OR (SELECT count(DISTINCT x->>'additionalCostId') FROM jsonb_array_elements(lines) x)<>jsonb_array_length(lines) THEN RETURN false; END IF;
        FOR j IN SELECT * FROM jsonb_array_elements(lines) LOOP
          fee:=(j->>'shippingFee')::numeric;
          IF fee IS NULL OR fee<0 OR fee>9007199254740991 OR fee<>trunc(fee)
            OR j->>'shippingPolicyVersion' IS DISTINCT FROM 'W3_70_30_V1'
            OR (j->>'customerShippingShare')::numeric IS DISTINCT FROM floor((7*fee+5)/10)
            OR (j->>'technicianShippingShare')::numeric IS DISTINCT FROM fee-floor((7*fee+5)/10)
            THEN RETURN false; END IF;
          total:=total+fee; customer:=customer+(j->>'customerShippingShare')::numeric;
          technician:=technician+(j->>'technicianShippingShare')::numeric;
        END LOOP;
        RETURN total=s AND customer=c AND technician=t AND s BETWEEN 0 AND 9007199254740991;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
      END $$;
      ALTER TABLE invoices DROP CONSTRAINT ck_invoice_shipping_cutover_closed, DROP CONSTRAINT ck_invoice_shipping_shares;
      ALTER TABLE invoices ADD CONSTRAINT ck_invoice_shipping_shares CHECK (
        (shipping_policy_version='LEGACY_100_0' AND shipping_shipments IS NULL AND
          ((customer_shipping_share IS NULL AND technician_shipping_share IS NULL) OR
          (shipping_fee BETWEEN 0 AND 9007199254740991 AND customer_shipping_share=shipping_fee AND technician_shipping_share=0)))
        OR (shipping_policy_version='W3_70_30_V1' AND customer_shipping_share IS NOT NULL AND technician_shipping_share IS NOT NULL
          AND w3_invoice_shipping_totals(shipping_shipments,shipping_fee,customer_shipping_share,technician_shipping_share)));

      CREATE OR REPLACE FUNCTION w3_live_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE lines jsonb; snap w3_order_commission_snapshots;
      BEGIN
        lines:=w3_invoice_shipping_source(NEW.service_order_id);
        IF lines IS NULL THEN
          IF NEW.shipping_policy_version<>'LEGACY_100_0' OR NEW.shipping_shipments IS NOT NULL THEN RAISE EXCEPTION 'W3_SOURCE_REQUIRED'; END IF;
          RETURN NEW;
        END IF;
        SELECT * INTO STRICT snap FROM w3_order_commission_snapshots WHERE service_order_id=NEW.service_order_id;
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
      CREATE FUNCTION w3_invoice_provenance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.shipping_shipments IS DISTINCT FROM OLD.shipping_shipments THEN RAISE EXCEPTION 'Invoice shipping provenance is immutable'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER w3_invoice_provenance_immutable BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION w3_invoice_provenance_immutable();

      -- Consumers validate frozen identity, never reprice using current config/consents after payment.
      CREATE FUNCTION w3_invoice_payment_verified(invoice_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
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
            AND f.state#>'{actual,technicianShippingShare}'=j->'technicianShippingShare'))
          FROM invoices i WHERE i.id=invoice_id),false)
      $$;
      CREATE OR REPLACE FUNCTION w3_live_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.completion_requested_at IS DISTINCT FROM OLD.completion_requested_at OR NEW.status::text IN ('completed','cancelled'))
          AND EXISTS(SELECT 1 FROM warehouse_delivery_cohorts WHERE service_order_id=OLD.id) THEN
          IF NEW.status::text='cancelled' OR NOT EXISTS(SELECT 1 FROM invoices WHERE service_order_id=OLD.id AND w3_invoice_payment_verified(id))
            THEN RAISE EXCEPTION 'Delivery obligations and finance require resolution'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION w3_live_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM warehouse_delivery_cohorts WHERE part_request_id=OLD.part_request_id))
          OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM warehouse_delivery_cohorts WHERE part_request_id=NEW.part_request_id)) THEN
          IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Delivery items immutable'; END IF;
          PERFORM 1 FROM service_orders WHERE id=(SELECT service_order_id FROM part_requests WHERE id=OLD.part_request_id) FOR UPDATE;
          IF (to_jsonb(NEW)-ARRAY['usage_status','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['usage_status','updated_at'])
            OR NEW.usage_status::text<>'used' OR NOT w3_received_request(OLD.part_request_id)
            OR EXISTS(SELECT 1 FROM invoices WHERE service_order_id=(SELECT service_order_id FROM part_requests WHERE id=OLD.part_request_id))
            THEN RAISE EXCEPTION 'W3_USAGE_OR_RETURN_UNSUPPORTED'; END IF;
        END IF;
        RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
      END $$;
      REVOKE ALL ON FUNCTION w3_received_request(uuid),w3_invoice_shipping_source(uuid),w3_invoice_shipping_totals(jsonb,bigint,bigint,bigint),
        w3_invoice_provenance_immutable(),w3_invoice_payment_verified(uuid) FROM PUBLIC;
      DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
          EXECUTE format('REVOKE ALL ON FUNCTION w3_received_request(uuid),w3_invoice_shipping_source(uuid),w3_invoice_shipping_totals(jsonb,bigint,bigint,bigint),w3_invoice_provenance_immutable(),w3_invoice_payment_verified(uuid) FROM %I',r);
        END IF;
      END LOOP; END $$;
    `);
  }
  async down(): Promise<void> {
    throw new Error('Forward-only W3 invoice cutover; preserve financial history');
  }
}
