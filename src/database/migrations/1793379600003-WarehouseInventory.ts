import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive W1 warehouse skeleton. No rows are seeded and existing part flows are untouched. */
export class WarehouseInventory1793379600003 implements MigrationInterface {
  name = 'WarehouseInventory1793379600003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE warehouse_status AS ENUM ('active', 'inactive');
      CREATE TYPE stock_movement_kind AS ENUM ('stock_in', 'correction');
      CREATE TABLE warehouses (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        name varchar(120) NOT NULL, address varchar(500), status warehouse_status NOT NULL DEFAULT 'active',
        responsible_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT
      );
      CREATE INDEX ix_warehouses_responsible_user ON warehouses(responsible_user_id);
      CREATE TABLE warehouse_stock (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        part_id uuid NOT NULL REFERENCES fixhome_parts(id) ON DELETE RESTRICT,
        on_hand integer NOT NULL DEFAULT 0, reserved integer NOT NULL DEFAULT 0, version integer NOT NULL DEFAULT 0,
        CONSTRAINT uq_warehouse_stock_warehouse_part UNIQUE (warehouse_id, part_id),
        CONSTRAINT chk_warehouse_stock_balance CHECK (on_hand >= reserved AND reserved >= 0),
        CONSTRAINT chk_warehouse_stock_version CHECK (version >= 0)
      );
      CREATE TABLE stock_movements (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        part_id uuid NOT NULL REFERENCES fixhome_parts(id) ON DELETE RESTRICT,
        actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        kind stock_movement_kind NOT NULL, delta integer NOT NULL CHECK (delta <> 0),
        reason varchar(500) NOT NULL CHECK (length(trim(reason)) > 0), idempotency_key uuid NOT NULL,
        request_fingerprint char(64) NOT NULL, on_hand_after integer NOT NULL CHECK (on_hand_after >= 0),
        reserved_after integer NOT NULL CHECK (reserved_after >= 0 AND on_hand_after >= reserved_after),
        CONSTRAINT uq_stock_movements_idempotency UNIQUE (idempotency_key)
      );
      CREATE INDEX ix_stock_movements_warehouse_created ON stock_movements(warehouse_id, created_at DESC);
      CREATE INDEX ix_stock_movements_part_created ON stock_movements(part_id, created_at DESC);
      CREATE FUNCTION prevent_stock_movement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Stock movements are append-only'; END $$;
      CREATE TRIGGER protect_stock_movements BEFORE UPDATE OR DELETE ON stock_movements
        FOR EACH ROW EXECUTE FUNCTION prevent_stock_movement_mutation();
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM stock_movements) OR EXISTS (SELECT 1 FROM warehouse_stock) OR EXISTS (SELECT 1 FROM warehouses)
      THEN RAISE EXCEPTION 'Refusing to drop warehouses with stock history'; END IF;
    END $$;`);
    await queryRunner.query(`DROP TABLE stock_movements, warehouse_stock, warehouses;
      DROP FUNCTION prevent_stock_movement_mutation(); DROP TYPE stock_movement_kind, warehouse_status;`);
  }
}
