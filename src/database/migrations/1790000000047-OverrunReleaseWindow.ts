import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 20/10/2026: thợ đang làm dở một đơn được nhả đơn kế tiếp (không trừ điểm)
 * khi đơn đó bắt đầu trong bấy nhiêu phút tới. Admin chỉnh trong cấu hình.
 */
export class OverrunReleaseWindow1790000000047 implements MigrationInterface {
  name = 'OverrunReleaseWindow1790000000047';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "value_type", "description")
      VALUES ('matching.overrun_release_window_minutes', '180', 'int',
        'Thợ đang làm dở đơn khác được nhả đơn kế tiếp (không trừ điểm) khi đơn đó bắt đầu trong bấy nhiêu phút tới')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "system_configs" WHERE "key" = 'matching.overrun_release_window_minutes'`);
  }
}
