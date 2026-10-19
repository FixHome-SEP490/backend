import { MigrationInterface, QueryRunner } from 'typeorm';

/** Extend 038 without replacing its function or touching its existing triggers. */
export class PartItemRealtime1790000000043 implements MigrationInterface {
  name = 'PartItemRealtime1790000000043';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE FUNCTION fixhome_notify_part_change() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE row_now jsonb; order_id uuid; technician_id uuid;
      BEGIN
        row_now := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
        IF TG_OP = 'UPDATE' AND row_now = to_jsonb(OLD) THEN RETURN NULL; END IF;
        IF TG_TABLE_NAME = 'part_request_items' THEN
          SELECT r.service_order_id, r.technician_id INTO order_id, technician_id
            FROM part_requests r WHERE r.id = (row_now->>'part_request_id')::uuid;
        ELSE
          order_id := (row_now->>'service_order_id')::uuid;
          technician_id := (row_now->>'technician_id')::uuid;
        END IF;
        IF order_id IS NOT NULL THEN
          PERFORM pg_notify('fixhome_changes', jsonb_strip_nulls(jsonb_build_object(
            't', TG_TABLE_NAME, 'op', lower(TG_OP), 'id', row_now->>'id',
            'so', order_id, 'tech', technician_id))::text);
        END IF;
        RETURN NULL;
      END $$;
      CREATE TRIGGER trg_realtime_part_request_items AFTER INSERT OR UPDATE OR DELETE ON part_request_items
        FOR EACH ROW EXECUTE FUNCTION fixhome_notify_part_change();
      CREATE TRIGGER trg_realtime_part_custodies AFTER INSERT OR UPDATE OR DELETE ON part_custodies
        FOR EACH ROW EXECUTE FUNCTION fixhome_notify_part_change();`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER trg_realtime_part_custodies ON part_custodies;
      DROP TRIGGER trg_realtime_part_request_items ON part_request_items;
      DROP FUNCTION fixhome_notify_part_change();`);
  }
}
