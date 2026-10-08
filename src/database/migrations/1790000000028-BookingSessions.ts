import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Booking sessions (PO 08/10/2026). A booking is either scheduled for one
 * session of a day (morning 08-12, afternoon 13-18, Vietnam time) or urgent
 * ("come now"). The customer can leave a note for the technician apart from
 * the problem description. The technician's last known GPS position is kept
 * so urgent bookings can be offered to whoever is nearby right now.
 */
export class BookingSessions1790000000028 implements MigrationInterface {
  name = 'BookingSessions1790000000028';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "booking_mode" varchar(16) NOT NULL DEFAULT 'scheduled'`);
    await queryRunner.query(`ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "slot" varchar(16) NULL`);
    await queryRunner.query(`ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "customer_note" text NULL`);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "bookings" ADD CONSTRAINT "CHK_bookings_mode" CHECK ("booking_mode" IN ('scheduled', 'urgent'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "bookings" ADD CONSTRAINT "CHK_bookings_slot" CHECK ("slot" IS NULL OR "slot" IN ('morning', 'afternoon'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await queryRunner.query(`ALTER TABLE "technician_profiles" ADD COLUMN IF NOT EXISTS "last_lat" decimal(10,7) NULL`);
    await queryRunner.query(`ALTER TABLE "technician_profiles" ADD COLUMN IF NOT EXISTS "last_lng" decimal(10,7) NULL`);
    await queryRunner.query(`ALTER TABLE "technician_profiles" ADD COLUMN IF NOT EXISTS "last_location_at" timestamptz NULL`);
    // The radius slider is 1-40 km (PO 08/10/2026).
    await queryRunner.query(`UPDATE "technician_profiles" SET "service_radius_km" = 40 WHERE "service_radius_km" > 40`);
    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "value_type", "description")
      VALUES
        ('booking.urgent_window_minutes', '120', 'int',
         'Đơn vãng lai (tới ngay): số phút kể từ lúc đặt mà kỹ thuật viên phải tới'),
        ('matching.gps_fresh_minutes', '15', 'int',
         'Vị trí GPS của kỹ thuật viên gửi về trong bấy nhiêu phút thì dùng để ghép đơn vãng lai'),
        ('order.depart_early_minutes', '60', 'int',
         'Kỹ thuật viên được bấm Xuất phát sớm nhất bấy nhiêu phút trước giờ hẹn')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "system_configs" WHERE "key" IN ('booking.urgent_window_minutes', 'matching.gps_fresh_minutes', 'order.depart_early_minutes')`);
    await queryRunner.query(`ALTER TABLE "technician_profiles" DROP COLUMN IF EXISTS "last_location_at"`);
    await queryRunner.query(`ALTER TABLE "technician_profiles" DROP COLUMN IF EXISTS "last_lng"`);
    await queryRunner.query(`ALTER TABLE "technician_profiles" DROP COLUMN IF EXISTS "last_lat"`);
    await queryRunner.query(`ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "CHK_bookings_slot"`);
    await queryRunner.query(`ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "CHK_bookings_mode"`);
    await queryRunner.query(`ALTER TABLE "bookings" DROP COLUMN IF EXISTS "customer_note"`);
    await queryRunner.query(`ALTER TABLE "bookings" DROP COLUMN IF EXISTS "slot"`);
    await queryRunner.query(`ALTER TABLE "bookings" DROP COLUMN IF EXISTS "booking_mode"`);
  }
}
