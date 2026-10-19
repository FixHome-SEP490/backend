import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the optional customer-reported device facts snapshot to Booking.
 * Existing rows remain NULL; the snapshot does not change fixed-price or
 * inspection-required booking semantics.
 */
export class BookingDeviceAttributes1790000000038 implements MigrationInterface {
  name = 'BookingDeviceAttributes1790000000038';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "device_attributes_snapshot" jsonb NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) {
      throw new Error('Booking device attributes rollback requires an active transaction');
    }
    await queryRunner.query(`
      LOCK TABLE "bookings" IN ACCESS EXCLUSIVE MODE
    `);
    await queryRunner.query(`
      DO $booking_device_attributes_guard$ BEGIN
        IF EXISTS (
          SELECT 1 FROM "bookings"
          WHERE "device_attributes_snapshot" IS NOT NULL
          LIMIT 1
        ) THEN
          RAISE EXCEPTION 'Booking device attribute snapshots exist; refusing destructive rollback';
        END IF;
      END $booking_device_attributes_guard$
    `);
    await queryRunner.query(`ALTER TABLE "bookings" DROP COLUMN IF EXISTS "device_attributes_snapshot"`);
  }
}
