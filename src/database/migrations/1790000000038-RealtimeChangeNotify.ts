import { MigrationInterface, QueryRunner } from 'typeorm';

/** Tables whose rows change what an order, booking, invitation, notification or wallet screen shows. */
const REALTIME_TABLES = [
  'service_orders',
  'order_status_history',
  'invoices',
  'quotations',
  'additional_cost_requests',
  'cash_settlements',
  'repair_evidences',
  'arrival_check_ins',
  'part_requests',
  'warranty_claims',
  'technician_assignments',
  'bookings',
  'booking_invitations',
  'notifications',
  'wallets',
  'wallet_transactions',
  'customer_wallets',
  'customer_wallet_transactions',
] as const;

/**
 * PO 18/10/2026: screens follow changes live. Every write to these tables, from
 * any backend instance and whatever way it is written (entity save, bulk
 * update, raw SQL), sends a small NOTIFY on `fixhome_changes`. Postgres delivers
 * it only when the transaction commits and drops it on rollback, so a screen is
 * never told about a change that did not happen. The payload carries ids only;
 * the listener reads the current state and decides who may see it.
 *
 * An update of `service_orders` that only moves the technician's position is
 * flagged `loc`, so the customer's map follows it without the rest of the order
 * being read again.
 */
export class RealtimeChangeNotify1790000000038 implements MigrationInterface {
  name = 'RealtimeChangeNotify1790000000038';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fixhome_notify_change() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        row_now jsonb;
        row_before jsonb;
        payload jsonb;
        moving text[] := ARRAY['technician_last_lat', 'technician_last_lng', 'technician_location_updated_at', 'updated_at'];
      BEGIN
        row_now := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
        IF TG_OP = 'UPDATE' THEN
          row_before := to_jsonb(OLD);
          IF row_now = row_before THEN
            RETURN NULL;
          END IF;
        END IF;
        payload := jsonb_strip_nulls(jsonb_build_object(
          't', TG_TABLE_NAME,
          'op', lower(TG_OP),
          'id', row_now->>'id',
          'so', row_now->>'service_order_id',
          'b', row_now->>'booking_id',
          'u', row_now->>'user_id',
          'tech', row_now->>'technician_id',
          'w', row_now->>'wallet_id'
        ));
        IF TG_TABLE_NAME = 'service_orders' AND TG_OP = 'UPDATE' AND (row_now - moving) = (row_before - moving) THEN
          payload := payload || '{"loc": true}'::jsonb;
        END IF;
        PERFORM pg_notify('fixhome_changes', payload::text);
        RETURN NULL;
      END
      $$`);
    for (const table of REALTIME_TABLES) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_realtime_${table}" ON "${table}"`);
      await queryRunner.query(
        `CREATE TRIGGER "trg_realtime_${table}" AFTER INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION fixhome_notify_change()`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [...REALTIME_TABLES].reverse()) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_realtime_${table}" ON "${table}"`);
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS fixhome_notify_change()`);
  }
}
