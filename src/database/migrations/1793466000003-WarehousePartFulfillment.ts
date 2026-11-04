import { MigrationInterface, QueryRunner } from 'typeorm';

/** W2 is additive. No stock, allocation, historical request or custody activation is seeded. */
export class WarehousePartFulfillment1793466000003 implements MigrationInterface {
  name = 'WarehousePartFulfillment1793466000003';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE part_request_warehouse_allocations (
        part_request_id uuid PRIMARY KEY REFERENCES part_requests(id) ON DELETE RESTRICT,
        warehouse_id uuid REFERENCES warehouses(id) ON DELETE RESTRICT,
        responsible_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
        technician_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        status varchar(24) NOT NULL CHECK (status IN ('manual_assistance','reserved','ready','handed_over','received','released')),
        token_hash char(64), token_expires_at timestamptz, token_version integer NOT NULL DEFAULT 0 CHECK (token_version >= 0),
        receipt_hash char(64), receipt_expires_at timestamptz,
        handed_over_at timestamptz, handed_over_by uuid REFERENCES users(id) ON DELETE RESTRICT, received_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((warehouse_id IS NULL) = (responsible_user_id IS NULL)),
        CHECK (status IN ('manual_assistance','released') OR warehouse_id IS NOT NULL),
        CHECK (status NOT IN ('handed_over','received') OR (handed_over_at IS NOT NULL AND handed_over_by IS NOT NULL)),
        CHECK (status <> 'received' OR received_at IS NOT NULL)
      );
      CREATE INDEX ix_warehouse_allocations_warehouse ON part_request_warehouse_allocations(warehouse_id);
      CREATE INDEX ix_warehouse_allocations_technician ON part_request_warehouse_allocations(technician_id, status);
      CREATE TABLE warehouse_fulfillment_commands (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        part_request_id uuid NOT NULL REFERENCES part_request_warehouse_allocations(part_request_id) ON DELETE RESTRICT,
        command_key varchar(256) NOT NULL, kind varchar(32) NOT NULL,
        actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
        fingerprint char(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(part_request_id, command_key)
      );
      CREATE TABLE warehouse_fulfillment_movements (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        command_id uuid NOT NULL REFERENCES warehouse_fulfillment_commands(id) ON DELETE RESTRICT,
        warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        part_id uuid NOT NULL REFERENCES fixhome_parts(id) ON DELETE RESTRICT,
        kind varchar(16) NOT NULL CHECK (kind IN ('RESERVE','RELEASE','ISSUE','RETURN')),
        delta integer NOT NULL, reservation_delta integer NOT NULL,
        on_hand_after integer NOT NULL, reserved_after integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(command_id, part_id), CHECK (on_hand_after >= reserved_after AND reserved_after >= 0),
        CHECK ((kind = 'RESERVE' AND delta = 0 AND reservation_delta > 0) OR
          (kind = 'RELEASE' AND delta = 0 AND reservation_delta < 0) OR
          (kind = 'ISSUE' AND delta < 0 AND reservation_delta = delta) OR
          (kind = 'RETURN' AND delta > 0 AND reservation_delta = 0))
      );
      CREATE INDEX ix_warehouse_fulfillment_movements ON warehouse_fulfillment_movements(warehouse_id, created_at);
      CREATE TRIGGER protect_warehouse_fulfillment_commands BEFORE UPDATE OR DELETE ON warehouse_fulfillment_commands
        FOR EACH ROW EXECUTE FUNCTION prevent_stock_movement_mutation();
      CREATE TRIGGER protect_warehouse_fulfillment_movements BEFORE UPDATE OR DELETE ON warehouse_fulfillment_movements
        FOR EACH ROW EXECUTE FUNCTION prevent_stock_movement_mutation();
      ALTER TABLE part_request_warehouse_allocations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE warehouse_fulfillment_commands ENABLE ROW LEVEL SECURITY;
      ALTER TABLE warehouse_fulfillment_movements ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON part_request_warehouse_allocations, warehouse_fulfillment_commands, warehouse_fulfillment_movements FROM PUBLIC;
      DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
          EXECUTE format('REVOKE ALL ON part_request_warehouse_allocations, warehouse_fulfillment_commands, warehouse_fulfillment_movements FROM %I',r);
        END IF;
      END LOOP; END $$;
    `);
    await this.custodyAdmission(q, true);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM part_request_warehouse_allocations)
      OR EXISTS (SELECT 1 FROM warehouse_fulfillment_commands) OR EXISTS (SELECT 1 FROM warehouse_fulfillment_movements)
      THEN RAISE EXCEPTION 'Refusing to drop W2 fulfillment history'; END IF; END $$`);
    await this.custodyAdmission(q, false);
    await q.query('DROP TABLE warehouse_fulfillment_movements, warehouse_fulfillment_commands, part_request_warehouse_allocations');
  }

  /** Preserve legacy admission and immutable cohort/version checks. W2 is admitted ONLY
   * from its durable physical ISSUE evidence, never a technician claim or an allocation alone. */
  private async custodyAdmission(q: QueryRunner, w2: boolean): Promise<void> {
    const physicalIssue = w2 ? `OR (NEW.tracking_only AND r.request_type::text IN ('pre_repair','quotation','additional') AND EXISTS (
      SELECT 1 FROM part_request_warehouse_allocations wa
      JOIN warehouse_fulfillment_commands c ON c.part_request_id=wa.part_request_id AND c.kind='issue'
        AND c.actor_user_id=wa.handed_over_by
      JOIN warehouse_fulfillment_movements m ON m.command_id=c.id AND m.warehouse_id=wa.warehouse_id
        AND m.kind='ISSUE' AND m.part_id=i.part_catalog_id
      WHERE wa.part_request_id=r.id AND wa.technician_id=r.technician_id
        AND wa.status='handed_over' AND wa.handed_over_at=NEW.handed_over_at
        AND wa.handed_over_at > a.activated_at AND wa.handed_over_by=wa.responsible_user_id
        AND m.delta=-(SELECT sum(ri.quantity) FROM part_request_items ri
          WHERE ri.part_request_id=r.id AND ri.part_source::text='fixhome' AND ri.part_catalog_id=i.part_catalog_id)
    ))` : '';
    await q.query(`CREATE OR REPLACE FUNCTION protect_part_custody() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Custody records are permanent'; END IF;
        IF TG_OP = 'INSERT' THEN
          IF NOT EXISTS (
            SELECT 1 FROM part_custody_activation a, part_requests r, part_request_items i
            WHERE a.id = 1 AND a.enabled AND a.activated_at = NEW.cohort_activated_at
              AND r.id = NEW.part_request_id AND r.service_order_id = NEW.service_order_id
              AND r.technician_id = NEW.technician_id
              AND i.id = NEW.part_request_item_id AND i.part_request_id = r.id
              AND i.part_source::text = 'fixhome' AND i.quantity = (NEW.state->>'issuedQty')::int
              AND ((r.received_at = NEW.handed_over_at AND r.received_at > a.activated_at) ${physicalIssue})
          ) THEN RAISE EXCEPTION 'Custody requires an eligible post-activation handover'; END IF;
        ELSE
          IF ROW(NEW.service_order_id, NEW.part_request_id, NEW.part_request_item_id, NEW.technician_id,
              NEW.part_name_snapshot, NEW.cohort_activated_at, NEW.handed_over_at, NEW.state->>'issuedQty', NEW.created_at)
            IS DISTINCT FROM ROW(OLD.service_order_id, OLD.part_request_id, OLD.part_request_item_id, OLD.technician_id,
              OLD.part_name_snapshot, OLD.cohort_activated_at, OLD.handed_over_at, OLD.state->>'issuedQty', OLD.created_at) THEN
            RAISE EXCEPTION 'Custody cohort and original custodian are immutable';
          END IF;
          IF (NEW.state->>'version')::bigint <> (OLD.state->>'version')::bigint + 1 THEN
            RAISE EXCEPTION 'Custody version must advance once';
          END IF;
        END IF;
        RETURN NEW;
      END $$;`);
  }
}
