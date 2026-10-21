import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 21/10/2026: khách chỉ được đổi lịch hẹn của một đơn một lần. Đếm số lần đã
 * đổi; đơn cũ lấy theo nhật ký BOOKING_RESCHEDULE đã ghi.
 */
export class BookingRescheduleOnce1790000000048 implements MigrationInterface {
  name = 'BookingRescheduleOnce1790000000048';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "reschedule_count" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`
      UPDATE "bookings" b SET "reschedule_count" = moved.n
      FROM (
        SELECT "resource_id" AS id, COUNT(*)::int AS n
        FROM "audit_logs"
        WHERE "action" = 'BOOKING_RESCHEDULE' AND "resource_type" = 'booking'
        GROUP BY "resource_id"
      ) moved
      WHERE b."id"::text = moved.id
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bookings" DROP COLUMN IF EXISTS "reschedule_count"`);
  }
}
