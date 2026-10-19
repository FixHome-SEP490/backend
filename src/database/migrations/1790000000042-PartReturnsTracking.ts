import { MigrationInterface, QueryRunner } from 'typeorm';

/** Dormant: does not activate custody or rewrite any legacy order, receipt or payout. */
export class PartReturnsTracking1790000000042 implements MigrationInterface {
  name = 'PartReturnsTracking1790000000042';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE part_custodies ADD COLUMN tracking_only boolean NOT NULL DEFAULT false;
      CREATE FUNCTION protect_part_return_tracking_mode() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW.tracking_only IS DISTINCT FROM OLD.tracking_only THEN
            RAISE EXCEPTION 'Custody finance mode is immutable';
          END IF;
        ELSE
          PERFORM id FROM part_custody_activation WHERE id = 1 FOR UPDATE;
          IF EXISTS (SELECT 1 FROM part_custodies WHERE tracking_only <> NEW.tracking_only) THEN
            RAISE EXCEPTION 'Cannot mix return tracking with P1 finance custody';
          END IF;
          IF NEW.tracking_only AND NOT EXISTS (
            SELECT 1 FROM service_orders WHERE id = NEW.service_order_id AND created_at > NEW.cohort_activated_at
          ) THEN RAISE EXCEPTION 'Return tracking requires a new post-activation order'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER protect_part_return_tracking_mode BEFORE INSERT OR UPDATE ON part_custodies
        FOR EACH ROW EXECUTE FUNCTION protect_part_return_tracking_mode();
    `);
    await this.entryChecks(q, true);
  }

  private async entryChecks(q: QueryRunner, discrepancy: boolean): Promise<void> {
    // The original migration used unnamed CHECKs. Find only its kind-dependent
    // checks rather than assuming PostgreSQL's generated constraint suffixes.
    await q.query(`DO $$ DECLARE c record; BEGIN
      FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'part_custody_entries'::regclass
        AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%'
      LOOP EXECUTE format('ALTER TABLE part_custody_entries DROP CONSTRAINT %I', c.conname); END LOOP;
    END $$;`);
    await q.query(`ALTER TABLE part_custody_entries
      ADD CONSTRAINT part_return_entry_kind CHECK (kind IN ('record_usage','declare_return','accept_return'${discrepancy ? ",'report_discrepancy'" : ''})),
      ADD CONSTRAINT part_return_entry_quantity CHECK (
        (kind = 'record_usage' AND quantity BETWEEN 0 AND 100) OR (kind <> 'record_usage' AND quantity BETWEEN 1 AND 100)),
      ADD CONSTRAINT part_return_entry_actor CHECK (
        (kind IN ('accept_return'${discrepancy ? ",'report_discrepancy'" : ''}) AND actor_role = 'service_manager') OR
        (kind IN ('record_usage','declare_return') AND actor_role = 'technician'))`);
  }

  async down(q: QueryRunner): Promise<void> {
    // TypeORM executes migrations transactionally. Lock before checking so an
    // in-flight receipt cannot slip between the guard and dropping its schema.
    await q.query(`LOCK TABLE part_custodies, part_custody_entries IN ACCESS EXCLUSIVE MODE`);
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM part_custodies WHERE tracking_only)
        OR EXISTS (SELECT 1 FROM part_custody_entries WHERE kind = 'report_discrepancy')
      THEN RAISE EXCEPTION 'Cannot revert persisted return tracking or discrepancies'; END IF;
    END $$;`);
    await this.entryChecks(q, false);
    await q.query(`DROP TRIGGER protect_part_return_tracking_mode ON part_custodies;
      DROP FUNCTION protect_part_return_tracking_mode();
      ALTER TABLE part_custodies DROP COLUMN tracking_only;`);
  }
}
