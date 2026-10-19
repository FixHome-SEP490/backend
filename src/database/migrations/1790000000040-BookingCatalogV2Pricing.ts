import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive only: no tier/service activation, seed, backfill or finance writes. */
export class BookingCatalogV2Pricing1790000000040 implements MigrationInterface {
  name = 'BookingCatalogV2Pricing1790000000040';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE bookings ADD COLUMN catalog_v2_pricing_snapshot jsonb NULL
      CHECK (catalog_v2_pricing_snapshot IS NULL OR jsonb_typeof(catalog_v2_pricing_snapshot) = 'object')`);
    await queryRunner.query(`
      CREATE FUNCTION preserve_booking_catalog_v2_pricing() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.catalog_v2_pricing_snapshot IS NOT NULL AND (
          NEW.catalog_v2_pricing_snapshot IS DISTINCT FROM OLD.catalog_v2_pricing_snapshot
          OR NEW.service_id IS DISTINCT FROM OLD.service_id
          OR NEW.device_attributes_snapshot IS DISTINCT FROM OLD.device_attributes_snapshot
          OR NEW.pricing_mode_snapshot IS DISTINCT FROM OLD.pricing_mode_snapshot
          OR NEW.fixed_unit_price_snapshot IS DISTINCT FROM OLD.fixed_unit_price_snapshot
          OR NEW.scope_snapshot IS DISTINCT FROM OLD.scope_snapshot
          OR NEW.quantity IS DISTINCT FROM OLD.quantity
        ) THEN
          RAISE EXCEPTION 'Catalog V2 booking pricing snapshot is immutable';
        END IF;
        RETURN NEW;
      END $$
    `);
    await queryRunner.query(`CREATE TRIGGER trg_preserve_booking_catalog_v2_pricing
      BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION preserve_booking_catalog_v2_pricing()`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) throw new Error('Catalog V2 pricing rollback requires an active transaction');
    await queryRunner.query('LOCK TABLE bookings IN ACCESS EXCLUSIVE MODE');
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM bookings WHERE catalog_v2_pricing_snapshot IS NOT NULL LIMIT 1) THEN
        RAISE EXCEPTION 'Catalog V2 pricing snapshots exist; refusing destructive rollback';
      END IF;
    END $$`);
    await queryRunner.query('DROP TRIGGER trg_preserve_booking_catalog_v2_pricing ON bookings');
    await queryRunner.query('DROP FUNCTION preserve_booking_catalog_v2_pricing()');
    await queryRunner.query('ALTER TABLE bookings DROP COLUMN catalog_v2_pricing_snapshot');
  }
}
