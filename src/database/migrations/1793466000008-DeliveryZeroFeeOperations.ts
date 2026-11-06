import { MigrationInterface, QueryRunner } from 'typeorm';

/** Forward-only zero-spending operational admission. Does not open the invoice or global gates.
 * No historical enrollment, money, payable, recipient or tax semantics. */
export class DeliveryZeroFeeOperations1793466000008 implements MigrationInterface {
  name = 'DeliveryZeroFeeOperations1793466000008';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE delivery_operation_evidence (
        id uuid PRIMARY KEY, part_request_id uuid NOT NULL REFERENCES warehouse_delivery_cohorts(part_request_id),
        service_order_id uuid NOT NULL REFERENCES service_orders(id), warehouse_id uuid NOT NULL REFERENCES warehouses(id),
        uploader_user_id uuid NOT NULL REFERENCES users(id), purpose varchar(32) NOT NULL
          CHECK(purpose IN ('QUOTE','ACTUAL','ISSUE_TO_COURIER','COURIER_DISPATCH','TECHNICIAN_RECEIPT')),
        quote_version integer NOT NULL CHECK(quote_version>0), private_object_ref varchar(512) NOT NULL,
        content_digest char(64) NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
        mime_type varchar(32) NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp')),
        file_size integer NOT NULL CHECK(file_size BETWEEN 1 AND 10485760), created_at timestamptz NOT NULL DEFAULT now(),
        CHECK(private_object_ref ~ ('^cloudinary://evidence/fixhome/evidence/'||service_order_id||'/'||uploader_user_id||'/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')),
        UNIQUE(private_object_ref), UNIQUE(id,part_request_id)
      );
      CREATE TABLE delivery_shipping_proposals (
        part_request_id uuid NOT NULL REFERENCES warehouse_delivery_cohorts(part_request_id),
        quote_version integer NOT NULL CHECK(quote_version>0), command_id uuid NOT NULL,
        warehouse_id uuid NOT NULL REFERENCES warehouses(id), responsible_user_id uuid NOT NULL REFERENCES users(id),
        assignment_id uuid NOT NULL REFERENCES technician_assignments(id), context_digest char(64) NOT NULL CHECK(context_digest ~ '^[a-f0-9]{64}$'),
        courier_reference varchar(256) NOT NULL CHECK(courier_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'),
        evidence_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(part_request_id,quote_version), UNIQUE(part_request_id,command_id),
        FOREIGN KEY(part_request_id,command_id) REFERENCES delivery_consent_commands(part_request_id,command_id),
        FOREIGN KEY(evidence_id,part_request_id) REFERENCES delivery_operation_evidence(id,part_request_id)
      );
      CREATE FUNCTION w3_live_quantities(request_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT coalesce(jsonb_agg(jsonb_build_object('partId',part_catalog_id,'quantity',qty) ORDER BY part_catalog_id),'[]'::jsonb)
        FROM (SELECT part_catalog_id,sum(quantity)::integer qty FROM part_request_items WHERE part_request_id=request_id GROUP BY part_catalog_id) x
      $$;
      CREATE FUNCTION w3_live_source(request_id uuid, warehouse uuid, manager_id uuid, assignment uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS(SELECT 1 FROM warehouse_delivery_cohorts c JOIN part_requests r ON r.id=c.part_request_id
          JOIN service_orders o ON o.id=r.service_order_id JOIN bookings b ON b.id=o.booking_id
          JOIN additional_cost_requests ac ON ac.id=r.additional_cost_id
          JOIN technician_assignments a ON a.id=assignment JOIN users t ON t.id=r.technician_id
          JOIN users cu ON cu.id=b.customer_id JOIN warehouses w ON w.id=warehouse JOIN users sm ON sm.id=manager_id
          WHERE r.id=request_id AND r.request_type::text='additional' AND r.fulfillment_method::text='delivery'
          AND r.quotation_id IS NULL AND r.shipping_fee=0 AND r.status::text='requested' AND r.received_at IS NULL AND r.qr_token IS NULL
          AND c.service_order_id=o.id AND c.technician_id=r.technician_id
          AND o.status::text IN ('accepted','en_route','under_repair') AND o.completion_requested_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM invoices WHERE service_order_id=o.id)
          AND ac.status::text='approved' AND ac.decided_at IS NOT NULL AND ac.service_order_id=o.id
          AND ac.technician_id=r.technician_id AND ac.decided_by_customer_id=b.customer_id AND ac.shipping_fee=0 AND ac.fulfillment_method::text='delivery'
          AND a.is_active AND a.service_order_id=o.id AND a.technician_id=t.id
          AND t.role::text='technician' AND t.is_active AND t.status::text='active'
          AND cu.role::text='customer' AND cu.is_active AND cu.status::text='active'
          AND w.status='active' AND w.responsible_user_id=sm.id AND sm.role::text='service_manager' AND sm.is_active AND sm.status::text='active'
          AND EXISTS(SELECT 1 FROM part_request_items WHERE part_request_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM part_request_items WHERE part_request_id=r.id AND (part_source::text<>'fixhome' OR part_catalog_id IS NULL OR quantity<=0))
          AND w3_live_quantities(r.id)=(SELECT coalesce(jsonb_agg(jsonb_build_object('partId',part_catalog_id,'quantity',qty) ORDER BY part_catalog_id),'[]'::jsonb)
            FROM (SELECT part_catalog_id,sum(quantity)::integer qty FROM additional_cost_items WHERE request_id=ac.id
              AND type::text='parts_equipment' AND part_source::text='fixhome' GROUP BY part_catalog_id) x))
      $$;
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
          THEN RAISE EXCEPTION 'Delivery evidence warehouse/proposal mismatch'; END IF;
        NEW.created_at:=now(); RETURN NEW;
      END $$;
      CREATE TRIGGER w3_live_evidence_guard BEFORE INSERT ON delivery_operation_evidence FOR EACH ROW EXECUTE FUNCTION w3_live_evidence_guard();
      CREATE FUNCTION w3_live_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE cmd delivery_consent_commands; e delivery_operation_evidence;
      BEGIN
        PERFORM 1 FROM warehouse_delivery_cohorts WHERE part_request_id=NEW.part_request_id FOR UPDATE;
        SELECT * INTO STRICT cmd FROM delivery_consent_commands WHERE part_request_id=NEW.part_request_id AND command_id=NEW.command_id;
        SELECT * INTO STRICT e FROM delivery_operation_evidence WHERE id=NEW.evidence_id;
        IF NOT w3_live_source(NEW.part_request_id,NEW.warehouse_id,NEW.responsible_user_id,NEW.assignment_id)
          OR cmd.kind NOT IN ('PROPOSE','REVISE') OR cmd.quote_version<>NEW.quote_version OR cmd.actor_user_id<>NEW.responsible_user_id
          OR cmd.evidence_id<>NEW.evidence_id OR cmd.shipping_total<>0 OR cmd.customer_share<>0 OR cmd.technician_share<>0
          OR cmd.labor_total<>0 OR cmd.commission_amount<>0 OR cmd.known_deductions<>0
          OR e.part_request_id<>NEW.part_request_id OR e.warehouse_id<>NEW.warehouse_id OR e.uploader_user_id<>NEW.responsible_user_id
          OR e.quote_version<>NEW.quote_version OR e.purpose<>'QUOTE'
          THEN RAISE EXCEPTION 'Delivery independent zero-fee proposal mismatch'; END IF;
        IF EXISTS(SELECT 1 FROM delivery_shipping_proposals p JOIN part_requests r ON r.id=p.part_request_id
          WHERE p.part_request_id<>NEW.part_request_id AND r.additional_cost_id=(SELECT additional_cost_id FROM part_requests WHERE id=NEW.part_request_id))
          THEN RAISE EXCEPTION 'Shipping source already bound'; END IF;
        NEW.created_at:=now(); RETURN NEW;
      END $$;
      CREATE TRIGGER w3_live_proposal_guard BEFORE INSERT ON delivery_shipping_proposals FOR EACH ROW EXECUTE FUNCTION w3_live_proposal_guard();

      -- Preserve the old closed function and immutable global gate, replacing only scoped admission.
      ALTER FUNCTION guard_w3_delivery_event() RENAME TO guard_w3_delivery_event_closed;
      DROP TRIGGER guard_w3_delivery_event ON warehouse_delivery_events;
      CREATE FUNCTION guard_w3_delivery_event() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE p delivery_shipping_proposals; s delivery_consent_sessions; prev warehouse_delivery_events;
        e delivery_operation_evidence; last_e jsonb; expected jsonb; previous_version integer; expected_role text; expected_actor uuid;
      BEGIN
        PERFORM 1 FROM warehouse_delivery_cohorts WHERE part_request_id=NEW.part_request_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Missing W3 cohort'; END IF;
        SELECT coalesce(max(result_version),0) INTO previous_version FROM warehouse_delivery_events WHERE part_request_id=NEW.part_request_id;
        IF NEW.expected_version<>previous_version THEN RAISE EXCEPTION 'W3 CAS conflict'; END IF;
        SELECT * INTO p FROM delivery_shipping_proposals WHERE part_request_id=NEW.part_request_id ORDER BY quote_version DESC LIMIT 1;
        IF NOT FOUND THEN
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
          SELECT * INTO STRICT s FROM delivery_consent_sessions WHERE part_request_id=NEW.part_request_id;
          IF NOT w3_live_source(p.part_request_id,p.warehouse_id,p.responsible_user_id,p.assignment_id) OR s.invalidated_at IS NOT NULL OR NOT delivery_consent_scope_matches(s)
            OR s.active_assignment_id<>p.assignment_id OR s.quote_version<>p.quote_version OR s.status<>'ACTUAL_RECORDED'
            OR NOT coalesce(s.projection#>'{quote,totalShippingFee}'='0'::jsonb AND s.projection#>'{actual,totalShippingFee}'='0'::jsonb
              AND s.projection->'customerConsent'<>'null'::jsonb AND s.projection->'technicianConsent'<>'null'::jsonb,false)
            THEN RAISE EXCEPTION 'Delivery consent/source/zero-spending gate'; END IF;
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
      CREATE TRIGGER guard_w3_delivery_event BEFORE INSERT ON warehouse_delivery_events FOR EACH ROW EXECUTE FUNCTION guard_w3_delivery_event();

      ALTER FUNCTION guard_w3_delivery_movement() RENAME TO guard_w3_delivery_movement_closed;
      DROP TRIGGER guard_w3_delivery_movement ON warehouse_delivery_movements;
      CREATE FUNCTION guard_w3_delivery_movement() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE e warehouse_delivery_events; own_reserved integer; qty integer; stock warehouse_stock;
      BEGIN
        SELECT * INTO STRICT e FROM warehouse_delivery_events WHERE part_request_id=NEW.part_request_id AND command_id=NEW.command_id;
        SELECT (j->>'quantity')::integer INTO qty FROM jsonb_array_elements(e.snapshot->'quantities') j WHERE (j->>'partId')::uuid=NEW.part_id;
        IF qty IS NULL OR NEW.kind<>e.kind OR NEW.warehouse_id<>(e.snapshot->>'warehouseId')::uuid OR NOT EXISTS(SELECT 1 FROM delivery_shipping_proposals WHERE part_request_id=NEW.part_request_id)
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
      CREATE TRIGGER guard_w3_delivery_movement BEFORE INSERT ON warehouse_delivery_movements FOR EACH ROW EXECUTE FUNCTION guard_w3_delivery_movement();
      CREATE FUNCTION w3_live_event_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE n integer;
      BEGIN
        IF NEW.kind IN ('RELEASE','ISSUE_TO_COURIER') OR (NEW.kind='RESERVE' AND NEW.snapshot->>'status'='RESERVED') THEN
          SELECT count(*) INTO n FROM warehouse_delivery_movements WHERE part_request_id=NEW.part_request_id AND command_id=NEW.command_id;
          IF n<>jsonb_array_length(NEW.snapshot->'quantities') THEN RAISE EXCEPTION 'Incomplete delivery movement journal'; END IF;
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER w3_live_event_complete AFTER INSERT ON warehouse_delivery_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w3_live_event_complete();

      -- No live cohort may be promoted into legacy QR/usage/billing. The receipt journal is distinct.
      CREATE FUNCTION w3_live_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM warehouse_delivery_cohorts WHERE part_request_id=OLD.id) AND
          (ROW(NEW.shipping_fee,NEW.received_at,NEW.qr_token) IS DISTINCT FROM ROW(OLD.shipping_fee,OLD.received_at,OLD.qr_token)
          OR NEW.status::text NOT IN ('requested','cancelled')) THEN RAISE EXCEPTION 'Delivery legacy projection/finance closed'; END IF;
        IF NEW.status::text='cancelled' AND EXISTS(SELECT 1 FROM warehouse_delivery_events e WHERE e.part_request_id=OLD.id
          AND e.result_version=(SELECT max(result_version) FROM warehouse_delivery_events WHERE part_request_id=OLD.id)
          AND e.snapshot->>'status' NOT IN ('RELEASED','INELIGIBLE','PENDING_ASSISTANCE')) THEN RAISE EXCEPTION 'Release physical reservation first; issued obligations require review'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER w3_live_request_guard BEFORE UPDATE ON part_requests FOR EACH ROW EXECUTE FUNCTION w3_live_request_guard();
      CREATE FUNCTION w3_live_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM warehouse_delivery_cohorts WHERE part_request_id=OLD.part_request_id))
          OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM warehouse_delivery_cohorts WHERE part_request_id=NEW.part_request_id))
          THEN RAISE EXCEPTION 'Delivery items/usage immutable pending custody contract'; END IF;
        RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
      END $$;
      CREATE TRIGGER w3_live_item_guard BEFORE INSERT OR UPDATE OR DELETE ON part_request_items FOR EACH ROW EXECUTE FUNCTION w3_live_item_guard();
      CREATE FUNCTION w3_live_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM warehouse_delivery_cohorts c JOIN part_requests r ON r.id=c.part_request_id WHERE c.service_order_id=NEW.service_order_id AND r.status::text<>'cancelled')
          THEN RAISE EXCEPTION 'Delivery financial ledger source required'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER w3_live_invoice_guard BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION w3_live_invoice_guard();
      CREATE FUNCTION w3_live_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.completion_requested_at IS DISTINCT FROM OLD.completion_requested_at OR NEW.status::text IN ('completed','cancelled'))
          AND EXISTS(SELECT 1 FROM warehouse_delivery_cohorts c JOIN part_requests r ON r.id=c.part_request_id WHERE c.service_order_id=OLD.id AND r.status::text<>'cancelled')
          THEN RAISE EXCEPTION 'Delivery obligations and finance require resolution'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER w3_live_order_guard BEFORE UPDATE ON service_orders FOR EACH ROW EXECUTE FUNCTION w3_live_order_guard();
      CREATE FUNCTION w3_live_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (TG_OP='DELETE' OR ROW(NEW.service_order_id,NEW.technician_id,NEW.is_active) IS DISTINCT FROM ROW(OLD.service_order_id,OLD.technician_id,OLD.is_active)) AND EXISTS(SELECT 1 FROM warehouse_delivery_events e JOIN warehouse_delivery_cohorts c ON c.part_request_id=e.part_request_id
          WHERE c.service_order_id=OLD.service_order_id AND e.result_version=(SELECT max(result_version) FROM warehouse_delivery_events WHERE part_request_id=e.part_request_id)
          AND e.snapshot->>'status' IN ('RESERVED','ISSUED_TO_COURIER','DISPATCH_RECORDED','TECHNICIAN_RECEIVED')) THEN RAISE EXCEPTION 'Delivery obligation must be resolved before reassignment'; END IF;
        RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
      END $$;
      CREATE TRIGGER w3_live_assignment_guard BEFORE UPDATE OR DELETE ON technician_assignments FOR EACH ROW EXECUTE FUNCTION w3_live_assignment_guard();
      CREATE FUNCTION w3_live_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE source_id uuid;
      BEGIN
        IF TG_TABLE_NAME='additional_cost_requests' THEN source_id:=OLD.id;
        ELSE source_id:=CASE WHEN TG_OP='INSERT' THEN NEW.request_id ELSE OLD.request_id END; END IF;
        IF EXISTS(SELECT 1 FROM delivery_shipping_proposals p JOIN part_requests r ON r.id=p.part_request_id WHERE r.additional_cost_id=source_id)
          THEN RAISE EXCEPTION 'Delivery approved source snapshot is immutable'; END IF;
        IF TG_TABLE_NAME='additional_cost_items' AND TG_OP='UPDATE' THEN
          IF EXISTS(SELECT 1 FROM delivery_shipping_proposals p JOIN part_requests r ON r.id=p.part_request_id WHERE r.additional_cost_id=NEW.request_id)
            THEN RAISE EXCEPTION 'Delivery approved source snapshot is immutable'; END IF;
        END IF;
        RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
      END $$;
      CREATE TRIGGER w3_live_source_guard BEFORE UPDATE OR DELETE ON additional_cost_requests FOR EACH ROW EXECUTE FUNCTION w3_live_source_guard();
      CREATE TRIGGER w3_live_source_items_guard BEFORE INSERT OR UPDATE OR DELETE ON additional_cost_items FOR EACH ROW EXECUTE FUNCTION w3_live_source_guard();
      CREATE FUNCTION w3_live_warehouse_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.responsible_user_id,NEW.status) IS DISTINCT FROM ROW(OLD.responsible_user_id,OLD.status) AND EXISTS(
          SELECT 1 FROM warehouse_delivery_events e WHERE (e.snapshot->>'warehouseId')::uuid=OLD.id
            AND e.result_version=(SELECT max(result_version) FROM warehouse_delivery_events WHERE part_request_id=e.part_request_id)
            AND e.snapshot->>'status' IN ('ISSUED_TO_COURIER','DISPATCH_RECORDED','TECHNICIAN_RECEIVED'))
          THEN RAISE EXCEPTION 'Resolve issued delivery before changing warehouse authority'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER w3_live_warehouse_guard BEFORE UPDATE ON warehouses FOR EACH ROW EXECUTE FUNCTION w3_live_warehouse_guard();
    `);
    for (const table of [
      'delivery_operation_evidence',
      'delivery_shipping_proposals',
    ]) {
      await q.query(`CREATE TRIGGER w3_live_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION protect_w3_physical_history();
        CREATE TRIGGER w3_live_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION protect_w3_physical_history();
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; REVOKE ALL ON ${table} FROM PUBLIC;
        DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
          IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON ${table} FROM %I',r); END IF;
        END LOOP; END $$;`);
    }
    await q.query(`REVOKE ALL ON FUNCTION w3_live_quantities(uuid),w3_live_source(uuid,uuid,uuid,uuid),w3_live_evidence_guard(),w3_live_proposal_guard(),
      guard_w3_delivery_event(),guard_w3_delivery_movement(),w3_live_event_complete(),w3_live_request_guard(),w3_live_item_guard(),w3_live_invoice_guard(),w3_live_order_guard(),w3_live_assignment_guard(),w3_live_source_guard(),w3_live_warehouse_guard() FROM PUBLIC;`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`LOCK TABLE delivery_shipping_proposals,delivery_operation_evidence IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM delivery_shipping_proposals) OR EXISTS(SELECT 1 FROM delivery_operation_evidence)
        THEN RAISE EXCEPTION 'Refusing to discard operational delivery history'; END IF; END $$;
      DROP TRIGGER w3_live_warehouse_guard ON warehouses;
      DROP TRIGGER w3_live_source_guard ON additional_cost_requests;
      DROP TRIGGER w3_live_source_items_guard ON additional_cost_items;
      DROP TRIGGER w3_live_assignment_guard ON technician_assignments;
      DROP TRIGGER w3_live_order_guard ON service_orders;
      DROP TRIGGER w3_live_invoice_guard ON invoices;
      DROP TRIGGER w3_live_item_guard ON part_request_items;
      DROP TRIGGER w3_live_request_guard ON part_requests;
      DROP TRIGGER w3_live_event_complete ON warehouse_delivery_events;
      DROP TRIGGER guard_w3_delivery_movement ON warehouse_delivery_movements;
      DROP TRIGGER guard_w3_delivery_event ON warehouse_delivery_events;
      DROP FUNCTION guard_w3_delivery_event(),guard_w3_delivery_movement();
      ALTER FUNCTION guard_w3_delivery_event_closed() RENAME TO guard_w3_delivery_event;
      ALTER FUNCTION guard_w3_delivery_movement_closed() RENAME TO guard_w3_delivery_movement;
      CREATE TRIGGER guard_w3_delivery_event BEFORE INSERT ON warehouse_delivery_events FOR EACH ROW EXECUTE FUNCTION guard_w3_delivery_event();
      CREATE TRIGGER guard_w3_delivery_movement BEFORE INSERT ON warehouse_delivery_movements FOR EACH ROW EXECUTE FUNCTION guard_w3_delivery_movement();
      DROP TABLE delivery_shipping_proposals,delivery_operation_evidence;
      DROP FUNCTION w3_live_quantities(uuid),w3_live_source(uuid,uuid,uuid,uuid),w3_live_evidence_guard(),w3_live_proposal_guard(),
        w3_live_event_complete(),w3_live_request_guard(),w3_live_item_guard(),w3_live_invoice_guard(),w3_live_order_guard(),w3_live_assignment_guard(),w3_live_source_guard(),w3_live_warehouse_guard();`);
  }
}
