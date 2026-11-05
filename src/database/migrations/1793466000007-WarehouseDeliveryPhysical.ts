import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive CLOSED technical slice. No historical cohort, stock seed, shipping approval,
 * courier verification, custody finance admission or invoice cutover. */
export class WarehouseDeliveryPhysical1793466000007 implements MigrationInterface {
  name = 'WarehouseDeliveryPhysical1793466000007';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE warehouse_delivery_gate (
        id integer PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT false,
        CONSTRAINT ck_w3_physical_cutover_closed CHECK(NOT enabled)
      );
      INSERT INTO warehouse_delivery_gate VALUES (1,false);
      CREATE TABLE warehouse_delivery_cohorts (
        part_request_id uuid PRIMARY KEY REFERENCES part_requests(id) ON DELETE RESTRICT,
        service_order_id uuid NOT NULL REFERENCES service_orders(id) ON DELETE RESTRICT,
        technician_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE warehouse_delivery_events (
        part_request_id uuid NOT NULL REFERENCES warehouse_delivery_cohorts(part_request_id) ON DELETE RESTRICT,
        command_id uuid NOT NULL CHECK(command_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
        actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        actor_role varchar(32) NOT NULL CHECK(actor_role IN ('technician','service_manager')),
        kind varchar(32) NOT NULL CHECK(kind IN ('RESERVE','RELEASE','ISSUE_TO_COURIER','COURIER_DISPATCH','TECHNICIAN_RECEIPT')),
        expected_version integer NOT NULL CHECK(expected_version>=0),
        result_version integer NOT NULL CHECK(result_version::bigint=expected_version::bigint+1),
        fingerprint char(64) NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
        snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(part_request_id,command_id), UNIQUE(part_request_id,result_version),
        CHECK(COALESCE(jsonb_typeof(snapshot->'version')='number' AND (snapshot->>'version')::numeric=result_version,false))
      );
      CREATE TABLE warehouse_delivery_movements (
        part_request_id uuid NOT NULL, command_id uuid NOT NULL,
        warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        part_id uuid NOT NULL REFERENCES fixhome_parts(id) ON DELETE RESTRICT,
        kind varchar(24) NOT NULL CHECK(kind IN ('RESERVE','RELEASE','ISSUE_TO_COURIER')),
        delta integer NOT NULL, reservation_delta integer NOT NULL,
        on_hand_after integer NOT NULL, reserved_after integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(part_request_id,command_id,part_id),
        FOREIGN KEY(part_request_id,command_id) REFERENCES warehouse_delivery_events(part_request_id,command_id) ON DELETE RESTRICT,
        CHECK(on_hand_after>=reserved_after AND reserved_after>=0),
        CHECK((kind='RESERVE' AND delta=0 AND reservation_delta>0) OR
          (kind='RELEASE' AND delta=0 AND reservation_delta<0) OR
          (kind='ISSUE_TO_COURIER' AND delta<0 AND reservation_delta=delta))
      );
      CREATE FUNCTION protect_w3_physical_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'W3 physical history is append-only'; END $$;
      CREATE FUNCTION guard_w3_delivery_cohort() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM part_requests r WHERE r.id=NEW.part_request_id
          AND r.service_order_id=NEW.service_order_id AND r.technician_id=NEW.technician_id AND r.fulfillment_method::text='delivery'
          AND r.status::text='requested' AND r.created_at>=transaction_timestamp()
          AND r.xmin::text::bigint=mod(txid_current(),4294967296))
        THEN RAISE EXCEPTION 'Only a new DELIVERY insert enrolls'; END IF;
        NEW.created_at:=now(); RETURN NEW;
      END $$;
      CREATE TRIGGER guard_w3_delivery_cohort BEFORE INSERT ON warehouse_delivery_cohorts FOR EACH ROW EXECUTE FUNCTION guard_w3_delivery_cohort();
      CREATE FUNCTION guard_w3_delivery_legacy_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM warehouse_delivery_cohorts c WHERE c.part_request_id=OLD.id) AND
          (ROW(NEW.service_order_id,NEW.technician_id,NEW.fulfillment_method,NEW.request_type,NEW.quotation_id,NEW.additional_cost_id)
           IS DISTINCT FROM ROW(OLD.service_order_id,OLD.technician_id,OLD.fulfillment_method,OLD.request_type,OLD.quotation_id,OLD.additional_cost_id)
           OR NEW.status::text NOT IN ('requested','cancelled') OR NEW.received_at IS NOT NULL OR NEW.qr_token IS NOT NULL)
        THEN RAISE EXCEPTION 'W3 physical activation closed; legacy QR is not courier proof'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER guard_w3_delivery_legacy BEFORE UPDATE ON part_requests FOR EACH ROW EXECUTE FUNCTION guard_w3_delivery_legacy_mutation();
      CREATE FUNCTION guard_w3_delivery_event() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE c warehouse_delivery_cohorts%ROWTYPE; previous_version integer;
      BEGIN
        SELECT * INTO c FROM warehouse_delivery_cohorts WHERE part_request_id=NEW.part_request_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Missing W3 cohort'; END IF;
        SELECT coalesce(max(result_version),0) INTO previous_version FROM warehouse_delivery_events WHERE part_request_id=NEW.part_request_id;
        IF NEW.expected_version<>previous_version THEN RAISE EXCEPTION 'W3 CAS conflict'; END IF;
        IF NOT EXISTS(SELECT 1 FROM users u JOIN technician_assignments a ON a.technician_id=u.id
          JOIN part_requests r ON r.id=c.part_request_id
          WHERE u.id=NEW.actor_user_id AND u.id=c.technician_id AND u.role::text='technician' AND NEW.actor_role='technician'
          AND u.is_active AND u.status::text='active' AND a.is_active AND a.service_order_id=c.service_order_id
          AND r.service_order_id=c.service_order_id AND r.technician_id=c.technician_id AND r.fulfillment_method::text='delivery')
        THEN RAISE EXCEPTION 'W3 actor/scope denied'; END IF;
        -- No admitted stock/physical state can be inserted, even through raw SQL.
        -- Opening requires a separately reviewed forward migration, not a config toggle.
        IF NEW.kind<>'RESERVE' OR NOT COALESCE(NEW.snapshot->>'status' IN ('INELIGIBLE','PENDING_ASSISTANCE'),false)
          OR NOT COALESCE(NEW.snapshot @> '{"warehouseId":null,"responsibleUserId":null,"quantities":[],"courierReference":null,"evidence":[]}'::jsonb,false)
          OR NOT COALESCE(NEW.snapshot->>'reason' IN ('LEGACY_REQUEST','NOT_DELIVERY','SCOPE_FROZEN','PARTS_SOURCE_UNVERIFIED','FIXHOME_ITEMS_REQUIRED','SHIPPING_APPROVAL_SOURCE_UNVERIFIED','DUAL_CONSENT_UNVERIFIED','NO_SINGLE_WAREHOUSE'),false)
          OR NEW.snapshot-ARRAY['status','reason','warehouseId','responsibleUserId','quantities','version','courierReference','evidence']<>'{}'::jsonb
        THEN RAISE EXCEPTION 'W3 physical activation closed'; END IF;
        NEW.created_at:=now(); RETURN NEW;
      END $$;
      CREATE TRIGGER guard_w3_delivery_event BEFORE INSERT ON warehouse_delivery_events FOR EACH ROW EXECUTE FUNCTION guard_w3_delivery_event();
      CREATE FUNCTION guard_w3_delivery_movement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'W3 physical activation closed'; END $$;
      CREATE TRIGGER guard_w3_delivery_movement BEFORE INSERT ON warehouse_delivery_movements FOR EACH ROW EXECUTE FUNCTION guard_w3_delivery_movement();
    `);
    for (const table of [
      'warehouse_delivery_gate',
      'warehouse_delivery_cohorts',
      'warehouse_delivery_events',
      'warehouse_delivery_movements',
    ]) {
      await q.query(`CREATE TRIGGER immutable_w3_history BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION protect_w3_physical_history();
        CREATE TRIGGER immutable_w3_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION protect_w3_physical_history();
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; REVOKE ALL ON ${table} FROM PUBLIC;
        DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
          IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON ${table} FROM %I',r); END IF;
        END LOOP; END $$;`);
    }
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM warehouse_delivery_cohorts) OR EXISTS(SELECT 1 FROM warehouse_delivery_events)
      THEN RAISE EXCEPTION 'Refusing to discard W3 physical history'; END IF; END $$;
      DROP TRIGGER guard_w3_delivery_legacy ON part_requests;
      DROP TABLE warehouse_delivery_movements,warehouse_delivery_events,warehouse_delivery_cohorts,warehouse_delivery_gate;
      DROP FUNCTION guard_w3_delivery_movement(),guard_w3_delivery_event(),guard_w3_delivery_legacy_mutation(),guard_w3_delivery_cohort(),protect_w3_physical_history();`);
  }
}
