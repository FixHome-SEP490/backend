import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BRX-063 (PO 07/10/2026): when the appointment time comes and the technician
 * has not set out, the technician and the customer are warned; ten minutes
 * later the order and the booking are cancelled. `departure_warned_at` records
 * the warning so it is sent once and the cancellation is timed from it.
 *
 * The shortlist is one or two technicians by product decision, so the
 * displayed `matching.max_shortlist` is brought in line with the API.
 */
export class DepartureWarning1790000000026 implements MigrationInterface {
  name = 'DepartureWarning1790000000026';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "service_orders" ADD COLUMN IF NOT EXISTS "departure_warned_at" timestamptz NULL`);
    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "value_type", "description")
      VALUES
        ('order.departure_grace_minutes', '0', 'int',
         'Số phút sau giờ hẹn mà kỹ thuật viên chưa xuất phát thì gửi cảnh báo cho kỹ thuật viên và khách (BRX-063)'),
        ('order.departure_cancel_minutes', '10', 'int',
         'Số phút sau cảnh báo mà kỹ thuật viên vẫn chưa xuất phát thì tự huỷ đơn và booking (BRX-063)')
      ON CONFLICT ("key") DO NOTHING
    `);
    await queryRunner.query(`UPDATE "system_configs" SET "value" = '2' WHERE "key" = 'matching.max_shortlist' AND "value" <> '2'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "system_configs" WHERE "key" IN ('order.departure_grace_minutes', 'order.departure_cancel_minutes')`);
    await queryRunner.query(`ALTER TABLE "service_orders" DROP COLUMN IF EXISTS "departure_warned_at"`);
  }
}
