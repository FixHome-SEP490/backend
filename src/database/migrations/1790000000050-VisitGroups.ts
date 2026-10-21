import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 21/10/2026: một lượt sửa cho tối đa 3 thiết bị của cùng một khách, chung
 * địa chỉ và buổi hẹn. Mỗi thiết bị là một booking con (quantity 1); bảng nhóm
 * chỉ gom chúng lại. Giới hạn 3 nằm ở CHECK + unique (group_id, sequence) nên
 * không thể có thiết bị thứ 4 dù client gửi gì. Tính năng tắt mặc định
 * (`visit_group.enabled` = false); hotline để trống tới khi admin điền số thật.
 */
export class VisitGroups1790000000050 implements MigrationInterface {
  name = 'VisitGroups1790000000050';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "visit_groups" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "customer_id" uuid NOT NULL REFERENCES "users"("id"),
        "address_id" uuid NOT NULL REFERENCES "addresses"("id"),
        "status" varchar(16) NOT NULL DEFAULT 'submitted',
        "booking_mode" varchar(16) NOT NULL,
        "slot" varchar(16),
        "preferred_start_at" timestamptz NOT NULL,
        "preferred_end_at" timestamptz NOT NULL,
        "idempotency_key" varchar(128),
        "version" integer NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_visit_groups_status" CHECK ("status" IN ('submitted', 'cancelled')),
        CONSTRAINT "chk_visit_groups_mode" CHECK ("booking_mode" IN ('scheduled', 'urgent'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_visit_groups_customer_created" ON "visit_groups" ("customer_id", "created_at" DESC)`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_visit_groups_customer_idempotency" ON "visit_groups" ("customer_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "visit_group_items" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "group_id" uuid NOT NULL REFERENCES "visit_groups"("id") ON DELETE CASCADE,
        "sequence" smallint NOT NULL,
        "booking_id" uuid NOT NULL REFERENCES "bookings"("id"),
        "service_id" uuid NOT NULL REFERENCES "services"("id"),
        "device_label" varchar(80),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_visit_group_items_sequence" CHECK ("sequence" BETWEEN 1 AND 3)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_visit_group_items_sequence" ON "visit_group_items" ("group_id", "sequence")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_visit_group_items_booking" ON "visit_group_items" ("booking_id")`);

    await queryRunner.query(`ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "visit_group_id" uuid REFERENCES "visit_groups"("id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_bookings_visit_group" ON "bookings" ("visit_group_id") WHERE "visit_group_id" IS NOT NULL`);

    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "value_type", "description") VALUES
        ('visit_group.enabled', 'false', 'boolean', 'Cho khách đặt tối đa 3 thiết bị trong một lượt (true/false). Chỉ bật khi đủ các bước nhận việc và thanh toán nhóm'),
        ('support.hotline', '', 'string', 'Số hotline hỗ trợ khách hiển thị khi đặt từ 4 thiết bị; để trống thì không hiện nút gọi')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "system_configs" WHERE "key" IN ('visit_group.enabled', 'support.hotline')`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_bookings_visit_group"`);
    await queryRunner.query(`ALTER TABLE "bookings" DROP COLUMN IF EXISTS "visit_group_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "visit_group_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "visit_groups"`);
  }
}
