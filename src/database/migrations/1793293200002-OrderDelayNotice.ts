import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 31/10/2026: thợ đang làm dở một đơn báo trễ cho đơn kế tiếp; khách chọn đợi,
 * chọn thợ khác hoặc hủy. Ba cột nullable nên đơn cũ không bị ảnh hưởng.
 */
export class OrderDelayNotice1793293200002 implements MigrationInterface {
  name = 'OrderDelayNotice1793293200002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "service_orders"
        ADD COLUMN IF NOT EXISTS "delay_notice_minutes" integer,
        ADD COLUMN IF NOT EXISTS "delay_noticed_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "delay_decision" varchar(8)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "service_orders"
        DROP COLUMN IF EXISTS "delay_decision",
        DROP COLUMN IF EXISTS "delay_noticed_at",
        DROP COLUMN IF EXISTS "delay_notice_minutes"
    `);
  }
}
