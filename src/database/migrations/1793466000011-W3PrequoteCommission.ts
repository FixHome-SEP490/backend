import { MigrationInterface, QueryRunner } from 'typeorm';

/** Preparation only: freeze approved labor/config before conditional positive quote.
 * No spending, deductions, invoice cutover or financial-role grants. */
export class W3PrequoteCommission1793466000011 implements MigrationInterface {
  name = 'W3PrequoteCommission1793466000011';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE w3_commission_config_versions (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        revision bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
        snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE FUNCTION w3_commission_config_snapshot() RETURNS jsonb LANGUAGE sql STABLE SET timezone='UTC' AS $$
        SELECT jsonb_build_object('key',key,'value',value,'valueType',value_type,
          'updatedAt',updated_at,'updatedByUserId',updated_by_user_id)
        FROM system_configs WHERE key='commission.rate_bps'
      $$;
      CREATE FUNCTION w3_commission_config_capture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME='system_configs' THEN
          IF (TG_OP<>'DELETE' AND NEW.key='commission.rate_bps') OR (TG_OP<>'INSERT' AND OLD.key='commission.rate_bps') THEN
            INSERT INTO w3_commission_config_versions(snapshot) VALUES ('{}');
          END IF;
          RETURN NULL;
        END IF;
        IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'DELIVERY_COMMISSION_CONFIG_INTERNAL_ONLY'; END IF;
        NEW.snapshot:=coalesce(w3_commission_config_snapshot(),'null'::jsonb);
        NEW.created_at:=now(); RETURN NEW;
      END $$;
      CREATE TRIGGER w3_commission_config_capture AFTER INSERT OR UPDATE OR DELETE ON system_configs
        FOR EACH ROW EXECUTE FUNCTION w3_commission_config_capture();
      CREATE TRIGGER w3_commission_config_version_guard BEFORE INSERT ON w3_commission_config_versions
        FOR EACH ROW EXECUTE FUNCTION w3_commission_config_capture();
      CREATE TRIGGER w3_commission_config_immutable BEFORE UPDATE OR DELETE ON w3_commission_config_versions
        FOR EACH ROW EXECUTE FUNCTION protect_w3_physical_history();
      CREATE TRIGGER w3_commission_config_no_truncate BEFORE TRUNCATE ON w3_commission_config_versions
        FOR EACH STATEMENT EXECUTE FUNCTION protect_w3_physical_history();

      -- Same labor calculation as generateInvoice, with strict source validation and no defaults.
      -- Metadata identifies approved versions; parts/shipping never increase L.
      CREATE FUNCTION w3_approved_labor_source(order_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET timezone='UTC' AS $$
      DECLARE b bookings; a technician_assignments; qt quotations; it record; ac record;
        base numeric:=0; total numeric:=0; fixed boolean; qitems jsonb:='[]'; additions jsonb:='[]'; lines jsonb;
      BEGIN
        SELECT bk.* INTO b FROM service_orders o JOIN bookings bk ON bk.id=o.booking_id WHERE o.id=order_id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF (SELECT count(*) FROM technician_assignments WHERE service_order_id=order_id AND is_active)<>1
          OR (SELECT count(*) FROM quotations WHERE service_order_id=order_id AND status::text='approved')>1 THEN RETURN NULL; END IF;
        SELECT * INTO a FROM technician_assignments WHERE service_order_id=order_id AND is_active;
        SELECT * INTO qt FROM quotations WHERE service_order_id=order_id AND status::text='approved';
        fixed:=b.pricing_mode_snapshot::text='fixed_price' OR (qt.id IS NULL AND b.fixed_unit_price_snapshot IS NOT NULL);
        IF fixed IS TRUE THEN
          IF b.fixed_unit_price_snapshot IS NULL OR b.fixed_unit_price_snapshot<0 OR b.fixed_unit_price_snapshot<>trunc(b.fixed_unit_price_snapshot)
            OR b.quantity IS NULL OR b.quantity<1 THEN RETURN NULL; END IF;
          base:=b.fixed_unit_price_snapshot*b.quantity;
        ELSE
          IF qt.id IS NULL OR qt.decided_at IS NULL OR qt.technician_id<>a.technician_id THEN RETURN NULL; END IF;
          FOR it IN SELECT id,description,quantity,unit_price,line_total FROM quotation_items WHERE quotation_id=qt.id AND type::text='labor' ORDER BY id LOOP
            IF it.quantity IS NULL OR it.quantity<1 OR it.unit_price IS NULL OR it.unit_price<0 OR it.unit_price<>trunc(it.unit_price)
              OR it.line_total IS DISTINCT FROM it.quantity::numeric*it.unit_price THEN RETURN NULL; END IF;
            base:=base+it.quantity::numeric*it.unit_price;
            qitems:=qitems||jsonb_build_array(to_jsonb(it));
          END LOOP;
          IF qitems='[]'::jsonb THEN RETURN NULL; END IF;
        END IF;
        total:=base;
        FOR ac IN SELECT r.id,r.technician_id,r.decided_at,r.decided_by_customer_id,r.supersedes_id,r.total_labor_delta
          FROM additional_cost_requests r WHERE r.service_order_id=order_id AND r.status::text='approved'
          AND EXISTS(SELECT 1 FROM additional_cost_items i WHERE i.request_id=r.id AND i.type::text='labor') ORDER BY r.id LOOP
          IF ac.decided_at IS NULL OR ac.decided_by_customer_id IS DISTINCT FROM b.customer_id OR ac.technician_id<>a.technician_id THEN RETURN NULL; END IF;
          lines:='[]';
          FOR it IN SELECT id,description,quantity,unit_price,line_total FROM additional_cost_items WHERE request_id=ac.id AND type::text='labor' ORDER BY id LOOP
            IF it.quantity IS NULL OR it.quantity<1 OR it.unit_price IS NULL OR it.unit_price<0 OR it.unit_price<>trunc(it.unit_price)
              OR it.line_total IS DISTINCT FROM it.quantity::numeric*it.unit_price THEN RETURN NULL; END IF;
            total:=total+it.quantity::numeric*it.unit_price; lines:=lines||jsonb_build_array(to_jsonb(it));
          END LOOP;
          additions:=additions||jsonb_build_array(to_jsonb(ac)||jsonb_build_object('items',lines));
        END LOOP;
        IF total<0 OR total>9007199254740991 OR total<>trunc(total) THEN RETURN NULL; END IF;
        RETURN jsonb_build_object('serviceOrderId',order_id,'assignmentId',a.id,'technicianId',a.technician_id,'laborTotal',total,
          'booking',jsonb_build_object('id',b.id,'customerId',b.customer_id,'pricingMode',b.pricing_mode_snapshot,
            'fixedUnitPrice',b.fixed_unit_price_snapshot,'quantity',b.quantity,'scope',b.scope_snapshot),
          'quotation',CASE WHEN fixed IS TRUE THEN NULL ELSE jsonb_build_object('id',qt.id,'version',qt.version,'decidedAt',qt.decided_at,'items',qitems) END,
          'additional',additions);
      END $$;

      CREATE TABLE w3_order_commission_snapshots (
        service_order_id uuid PRIMARY KEY REFERENCES service_orders(id),
        first_request_id uuid NOT NULL, first_terms_version integer NOT NULL CHECK(first_terms_version=1),
        config_version_id uuid NOT NULL REFERENCES w3_commission_config_versions(id),
        rate_bps integer NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),
        labor_total bigint NOT NULL CHECK(labor_total BETWEEN 0 AND 9007199254740991),
        commission_amount bigint NOT NULL CHECK(commission_amount BETWEEN 0 AND labor_total),
        labor_source jsonb NOT NULL, labor_fingerprint varchar(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_w3_commission_first_terms FOREIGN KEY(first_request_id,first_terms_version)
          REFERENCES delivery_fee_terms(part_request_id,result_version) DEFERRABLE INITIALLY DEFERRED
      );
      ALTER TABLE delivery_fee_terms ADD COLUMN commission_order_id uuid REFERENCES w3_order_commission_snapshots(service_order_id),
        ADD CONSTRAINT ck_w3_terms_commission_scope CHECK(commission_order_id IS NULL OR commission_order_id=service_order_id);

      CREATE FUNCTION w3_prequote_commission_current(order_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT coalesce((SELECT s.labor_source=w3_approved_labor_source(order_id)
          AND s.config_version_id=(SELECT id FROM w3_commission_config_versions ORDER BY revision DESC LIMIT 1)
          AND cv.snapshot=w3_commission_config_snapshot()
          FROM w3_order_commission_snapshots s JOIN w3_commission_config_versions cv ON cv.id=s.config_version_id
          WHERE s.service_order_id=order_id),false)
      $$;
      CREATE FUNCTION w3_prequote_commission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE src jsonb; cv w3_commission_config_versions; cfg jsonb; snap w3_order_commission_snapshots;
      BEGIN
        IF TG_TABLE_NAME='w3_order_commission_snapshots' THEN
          IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'DELIVERY_COMMISSION_INTERNAL_ONLY'; END IF;
          src:=w3_approved_labor_source(NEW.service_order_id);
          IF src IS NULL THEN RAISE EXCEPTION 'DELIVERY_COMMISSION_APPROVED_LABOR_REQUIRED'; END IF;
          SELECT * INTO STRICT cv FROM w3_commission_config_versions ORDER BY revision DESC LIMIT 1;
          cfg:=cv.snapshot;
          IF cfg IS DISTINCT FROM w3_commission_config_snapshot() OR cfg->>'valueType' IS DISTINCT FROM 'int'
            OR NOT coalesce(cfg->>'value' ~ '^(0|[1-9][0-9]{0,4})$',false)
            OR (cfg->>'value')::numeric>10000 THEN RAISE EXCEPTION 'DELIVERY_COMMISSION_CONFIG_REQUIRED'; END IF;
          NEW.config_version_id:=cv.id; NEW.rate_bps:=(cfg->>'value')::integer;
          NEW.labor_source:=src; NEW.labor_total:=(src->>'laborTotal')::numeric::bigint;
          NEW.commission_amount:=floor((NEW.labor_total::numeric*NEW.rate_bps+5000)/10000);
          NEW.labor_fingerprint:=encode(sha256(convert_to(src::text,'UTF8')),'hex'); NEW.created_at:=now();
          RETURN NEW;
        END IF;
        -- Runs AFTER the immutable 0010 actor/source/CAS/evidence guard (trigger name ordering).
        -- It has already taken Order -> Technician -> Request locks and constructed NEW.state.
        PERFORM 1 FROM system_configs WHERE key='commission.rate_bps' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'DELIVERY_COMMISSION_CONFIG_REQUIRED'; END IF;
        PERFORM 1 FROM bookings WHERE id=(SELECT booking_id FROM service_orders WHERE id=NEW.service_order_id) FOR SHARE;
        PERFORM 1 FROM quotations WHERE service_order_id=NEW.service_order_id ORDER BY id FOR SHARE;
        PERFORM 1 FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE service_order_id=NEW.service_order_id) ORDER BY id FOR SHARE;
        PERFORM 1 FROM additional_cost_requests WHERE service_order_id=NEW.service_order_id ORDER BY id FOR SHARE;
        PERFORM 1 FROM additional_cost_items WHERE request_id IN (SELECT id FROM additional_cost_requests WHERE service_order_id=NEW.service_order_id) ORDER BY id FOR SHARE;
        SELECT * INTO snap FROM w3_order_commission_snapshots WHERE service_order_id=NEW.service_order_id;
        IF NOT FOUND THEN
          IF NEW.kind<>'PROPOSE' OR EXISTS(SELECT 1 FROM delivery_fee_terms WHERE service_order_id=NEW.service_order_id)
            THEN RAISE EXCEPTION 'DELIVERY_COMMISSION_HISTORICAL_TERMS_REQUIRE_REVIEW'; END IF;
          SELECT * INTO cv FROM w3_commission_config_versions ORDER BY revision DESC LIMIT 1;
          IF NOT FOUND THEN INSERT INTO w3_commission_config_versions(snapshot) VALUES ('{}'); END IF;
          INSERT INTO w3_order_commission_snapshots(service_order_id,first_request_id,first_terms_version)
            VALUES(NEW.service_order_id,NEW.part_request_id,NEW.result_version) RETURNING * INTO snap;
        END IF;
        IF NOT w3_prequote_commission_current(NEW.service_order_id) THEN RAISE EXCEPTION 'DELIVERY_COMMISSION_SOURCE_DRIFT'; END IF;
        NEW.commission_order_id:=snap.service_order_id;
        IF NEW.kind='PROPOSE' THEN
          NEW.state:=jsonb_set(NEW.state,'{quote,fingerprint}',to_jsonb(encode(sha256(convert_to(
            (jsonb_build_array(NEW.state#>>'{quote,fingerprint}',snap.labor_fingerprint,snap.config_version_id,snap.commission_amount))::text,'UTF8')),'hex')));
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER w3_fee_terms_zz_commission BEFORE INSERT ON delivery_fee_terms FOR EACH ROW EXECUTE FUNCTION w3_prequote_commission_guard();
      CREATE TRIGGER w3_order_commission_guard BEFORE INSERT ON w3_order_commission_snapshots FOR EACH ROW EXECUTE FUNCTION w3_prequote_commission_guard();
      CREATE TRIGGER w3_order_commission_immutable BEFORE UPDATE OR DELETE ON w3_order_commission_snapshots FOR EACH ROW EXECUTE FUNCTION protect_w3_physical_history();
      CREATE TRIGGER w3_order_commission_no_truncate BEFORE TRUNCATE ON w3_order_commission_snapshots FOR EACH STATEMENT EXECUTE FUNCTION protect_w3_physical_history();
      ALTER TABLE w3_order_commission_snapshots ENABLE ROW LEVEL SECURITY;
      ALTER TABLE w3_commission_config_versions ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON w3_order_commission_snapshots,w3_commission_config_versions FROM PUBLIC;
      REVOKE ALL ON SEQUENCE w3_commission_config_versions_revision_seq FROM PUBLIC;
      REVOKE ALL ON FUNCTION w3_commission_config_snapshot(),w3_commission_config_capture(),w3_approved_labor_source(uuid),w3_prequote_commission_current(uuid),w3_prequote_commission_guard() FROM PUBLIC;
      DO $$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
          EXECUTE format('REVOKE ALL ON w3_order_commission_snapshots,w3_commission_config_versions FROM %I',role_name);
          EXECUTE format('REVOKE ALL ON SEQUENCE w3_commission_config_versions_revision_seq FROM %I',role_name);
          EXECUTE format('REVOKE ALL ON FUNCTION w3_commission_config_snapshot(),w3_commission_config_capture(),w3_approved_labor_source(uuid),w3_prequote_commission_current(uuid),w3_prequote_commission_guard() FROM %I',role_name);
        END IF;
      END LOOP; END $$;
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`LOCK TABLE w3_order_commission_snapshots,w3_commission_config_versions IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM w3_order_commission_snapshots) OR EXISTS(SELECT 1 FROM w3_commission_config_versions)
        THEN RAISE EXCEPTION 'Refusing to discard W3 commission history'; END IF; END $$;
      DROP TRIGGER w3_fee_terms_zz_commission ON delivery_fee_terms;
      DROP TRIGGER w3_commission_config_capture ON system_configs;
      ALTER TABLE delivery_fee_terms DROP COLUMN commission_order_id;
      DROP TABLE w3_order_commission_snapshots;
      DROP TABLE w3_commission_config_versions;
      DROP FUNCTION w3_prequote_commission_guard(),w3_prequote_commission_current(uuid),w3_approved_labor_source(uuid),w3_commission_config_capture(),w3_commission_config_snapshot();`);
  }
}
