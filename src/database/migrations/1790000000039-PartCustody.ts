import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive only. INACTIVE after migration; no legacy backfill or wallet/invoice mutation. */
export class PartCustody1790000000039 implements MigrationInterface {
  name = 'PartCustody1790000000039';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE part_custody_activation (
        id integer PRIMARY KEY CHECK (id = 1), enabled boolean NOT NULL DEFAULT false,
        activated_at timestamptz, CHECK (NOT enabled OR activated_at IS NOT NULL)
      );
      INSERT INTO part_custody_activation (id) VALUES (1);
      CREATE TABLE part_custodies (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        service_order_id uuid NOT NULL REFERENCES service_orders(id) ON DELETE RESTRICT,
        part_request_id uuid NOT NULL REFERENCES part_requests(id) ON DELETE RESTRICT,
        part_request_item_id uuid NOT NULL REFERENCES part_request_items(id) ON DELETE RESTRICT,
        technician_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        part_name_snapshot varchar(255) NOT NULL,
        cohort_activated_at timestamptz NOT NULL, handed_over_at timestamptz NOT NULL,
        state jsonb NOT NULL,
        CONSTRAINT uq_part_custody_item UNIQUE (part_request_item_id),
        CHECK (handed_over_at > cohort_activated_at),
        CHECK ((state->>'issuedQty')::int BETWEEN 1 AND 100),
        CHECK ((state->>'usedQty')::int BETWEEN 0 AND (state->>'issuedQty')::int),
        CHECK ((state->>'managerAcceptedQty')::int BETWEEN 0 AND (state->>'issuedQty')::int - (state->>'usedQty')::int),
        CHECK ((state->>'outstandingQty')::int = (state->>'issuedQty')::int - (state->>'usedQty')::int - (state->>'managerAcceptedQty')::int),
        CHECK ((state->>'version')::bigint >= 0),
        CHECK (state->>'source' = 'fixhome'),
        CHECK (state->>'serviceOrderId' = service_order_id::text AND state->>'partRequestId' = part_request_id::text
          AND state->>'partRequestItemId' = part_request_item_id::text AND state->>'originalCustodianTechnicianId' = technician_id::text)
      );
      CREATE INDEX ix_part_custody_order ON part_custodies(service_order_id);
      CREATE INDEX ix_part_custody_technician ON part_custodies(technician_id);
      CREATE TABLE part_custody_entries (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        custody_id uuid NOT NULL REFERENCES part_custodies(id) ON DELETE RESTRICT,
        kind varchar(24) NOT NULL CHECK (kind IN ('record_usage','declare_return','accept_return')),
        idempotency_key varchar(128) NOT NULL, request_fingerprint varchar(64) NOT NULL,
        actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        actor_role varchar(32) NOT NULL,
        occurred_at timestamptz NOT NULL, quantity integer NOT NULL, version integer NOT NULL CHECK (version > 0),
        response jsonb NOT NULL,
        CONSTRAINT uq_part_custody_entry_key UNIQUE (custody_id, idempotency_key),
        CONSTRAINT uq_part_custody_entry_version UNIQUE (custody_id, version),
        CHECK ((kind = 'record_usage' AND quantity BETWEEN 0 AND 100) OR (kind <> 'record_usage' AND quantity BETWEEN 1 AND 100)),
        CHECK ((kind = 'accept_return' AND actor_role = 'service_manager') OR (kind <> 'accept_return' AND actor_role = 'technician'))
      );
      CREATE TABLE part_custody_payouts (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
        service_order_id uuid NOT NULL REFERENCES service_orders(id) ON DELETE RESTRICT,
        technician_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        component varchar(16) NOT NULL CHECK (component IN ('NET_LABOR','NONLABOR')),
        amount bigint NOT NULL CHECK (amount >= 0), idempotency_key varchar(128) NOT NULL UNIQUE,
        CONSTRAINT uq_custody_payout_component UNIQUE (invoice_id, component)
      );
      CREATE FUNCTION protect_part_custody_activation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Custody activation is permanent'; END IF;
        IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
          RAISE EXCEPTION 'Custody activation timestamp is immutable';
        END IF;
        IF OLD.activated_at IS NULL AND NEW.enabled THEN NEW.activated_at := date_trunc('milliseconds', clock_timestamp()); END IF;
        IF NOT NEW.enabled AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
          RAISE EXCEPTION 'Inactive custody cannot set a cohort timestamp';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER protect_part_custody_activation BEFORE UPDATE OR DELETE ON part_custody_activation
        FOR EACH ROW EXECUTE FUNCTION protect_part_custody_activation();
      CREATE FUNCTION protect_part_custody() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Custody records are permanent'; END IF;
        IF TG_OP = 'INSERT' THEN
          IF NOT EXISTS (
            SELECT 1 FROM part_custody_activation a, part_requests r, part_request_items i
            WHERE a.id = 1 AND a.enabled AND a.activated_at = NEW.cohort_activated_at
              AND r.id = NEW.part_request_id AND r.service_order_id = NEW.service_order_id
              AND r.technician_id = NEW.technician_id AND r.received_at = NEW.handed_over_at
              AND r.received_at > a.activated_at AND i.id = NEW.part_request_item_id
              AND i.part_request_id = r.id AND i.part_source::text = 'fixhome'
              AND i.quantity = (NEW.state->>'issuedQty')::int
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
      END $$;
      CREATE TRIGGER protect_part_custody BEFORE INSERT OR UPDATE OR DELETE ON part_custodies
        FOR EACH ROW EXECUTE FUNCTION protect_part_custody();
      CREATE FUNCTION protect_part_custody_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Custody ledger is append-only'; END $$;
      CREATE TRIGGER protect_part_custody_entries BEFORE UPDATE OR DELETE ON part_custody_entries
        FOR EACH ROW EXECUTE FUNCTION protect_part_custody_ledger();
      CREATE TRIGGER protect_part_custody_payouts BEFORE UPDATE OR DELETE ON part_custody_payouts
        FOR EACH ROW EXECUTE FUNCTION protect_part_custody_ledger();
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    // Refuse a data-losing rollback after cutover. Never rewrite past receipts or earnings.
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM part_custody_activation WHERE activated_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM part_custodies) OR EXISTS (SELECT 1 FROM part_custody_payouts)
      THEN RAISE EXCEPTION 'Cannot revert activated custody; preserve records and reconcile manually'; END IF;
    END $$;`);
    await q.query(`DROP TABLE part_custody_payouts, part_custody_entries, part_custodies, part_custody_activation;
      DROP FUNCTION protect_part_custody_ledger(), protect_part_custody(), protect_part_custody_activation();`);
  }
}
