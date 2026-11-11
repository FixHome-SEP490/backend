import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Duyệt danh tính xong thì thợ hẹn lên trụ sở gặp trực tiếp; gặp xong admin mới duyệt hồ sơ (PO 09/11/2026).
 * Forward-only, chỉ thêm: bảng trụ sở, bảng lượt hẹn, cấp độ tự khai, mốc xác nhận danh tính, khoá cấu hình.
 */
export class TechnicianOfficeVisits1794220800000 implements MigrationInterface {
  name = 'TechnicianOfficeVisits1794220800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "technician_visit_offices" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "name" varchar(120) NOT NULL,
        "address" varchar(500) NOT NULL,
        "latitude" numeric(10,7) NULL,
        "longitude" numeric(10,7) NULL,
        "phone" varchar(32) NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "visit_days" smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
        "open_time" time NOT NULL DEFAULT '08:00',
        "close_time" time NOT NULL DEFAULT '17:00',
        "lunch_start" time NULL DEFAULT '11:30',
        "lunch_end" time NULL DEFAULT '13:30',
        "slot_minutes" integer NOT NULL DEFAULT 30 CHECK ("slot_minutes" BETWEEN 10 AND 240),
        "slot_capacity" integer NOT NULL DEFAULT 2 CHECK ("slot_capacity" BETWEEN 1 AND 50),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_visit_office_hours" CHECK ("open_time" < "close_time")
      )`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "technician_office_visits" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "technician_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "office_id" UUID NOT NULL REFERENCES "technician_visit_offices"("id"),
        "scheduled_at" timestamptz NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'scheduled'
          CHECK ("status" IN ('scheduled', 'attended', 'missed', 'cancelled')),
        "attended_at" timestamptz NULL,
        "attended_by" UUID NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "note" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // Mỗi thợ chỉ có một lượt đang chờ; lịch sử (vắng, đã hủy, đã gặp) giữ nguyên.
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_one_scheduled_office_visit"
      ON "technician_office_visits" ("technician_id") WHERE "status" = 'scheduled'`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_office_visits_office_time"
      ON "technician_office_visits" ("office_id", "scheduled_at")`);
    await queryRunner.query(`ALTER TABLE "technician_skills" ADD COLUMN IF NOT EXISTS "declared_level" varchar(50) NULL`);
    await queryRunner.query(`ALTER TABLE "technician_profiles"
      ADD COLUMN IF NOT EXISTS "identity_verified_at" timestamptz NULL,
      ADD COLUMN IF NOT EXISTS "profile_review_rejection_reason" text NULL`);
    // Thợ đã duyệt theo luồng cũ: danh tính đã được xác nhận cùng lúc đó.
    await queryRunner.query(`UPDATE "technician_profiles" SET "identity_verified_at" = "updated_at"
      WHERE "verification_status" = 'verified' AND "identity_verified_at" IS NULL`);
    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "value_type", "description")
      VALUES
        ('office.support_phone', '', 'string',
         'Số điện thoại thợ liên hệ quản lý dịch vụ khi bị khóa đặt lịch lên trụ sở (vắng quá số lần cho phép)'),
        ('office.max_missed_visits', '2', 'int',
         'Số lần vắng buổi hẹn lên trụ sở thì thợ bị khóa đặt lịch và phải liên hệ quản lý dịch vụ'),
        ('office.visit_days_ahead', '7', 'int',
         'Thợ được đặt lịch lên trụ sở trong bấy nhiêu ngày tới'),
        ('office.min_notice_hours', '2', 'int',
         'Lịch lên trụ sở phải đặt trước giờ hẹn ít nhất bấy nhiêu giờ')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "system_configs" WHERE "key" IN
      ('office.support_phone', 'office.max_missed_visits', 'office.visit_days_ahead', 'office.min_notice_hours')`);
    await queryRunner.query(`ALTER TABLE "technician_profiles"
      DROP COLUMN IF EXISTS "profile_review_rejection_reason", DROP COLUMN IF EXISTS "identity_verified_at"`);
    await queryRunner.query(`ALTER TABLE "technician_skills" DROP COLUMN IF EXISTS "declared_level"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "technician_office_visits"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "technician_visit_offices"`);
  }
}
