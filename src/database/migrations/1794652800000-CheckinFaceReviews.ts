import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Khuôn mặt check-in lệch ảnh đăng ký thì dừng ở trạng thái chờ quản lý dịch vụ duyệt (PO 20/11/2026).
 * Forward-only, chỉ thêm: bảng lượt xác minh khuôn mặt (mỗi lượt chụp lại, mỗi lần qua, mỗi lần chờ duyệt) và khoá cấu hình.
 */
export class CheckinFaceReviews1794652800000 implements MigrationInterface {
  name = 'CheckinFaceReviews1794652800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "checkin_face_reviews" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "group_id" UUID NOT NULL,
        "service_order_id" UUID NOT NULL REFERENCES "service_orders"("id") ON DELETE CASCADE,
        "technician_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "evidence_id" UUID NULL REFERENCES "repair_evidences"("id") ON DELETE SET NULL,
        "similarity" numeric(5,2) NULL,
        "status" varchar(16) NOT NULL
          CHECK ("status" IN ('retake', 'pending', 'approved', 'rejected')),
        "reviewed_by" UUID NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "reviewed_at" timestamptz NULL,
        "review_note" text NULL,
        "reminded_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // Mỗi (đơn, kỹ thuật viên) chỉ có một yêu cầu đang chờ duyệt.
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_one_pending_checkin_face_review"
      ON "checkin_face_reviews" ("service_order_id", "technician_id") WHERE "status" = 'pending'`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_checkin_face_reviews_order_tech"
      ON "checkin_face_reviews" ("service_order_id", "technician_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_checkin_face_reviews_status"
      ON "checkin_face_reviews" ("status", "created_at")`);
    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "value_type", "description")
      VALUES
        ('checkin_face.review_sla_minutes', '10', 'int',
         'Yêu cầu duyệt khuôn mặt check-in chờ quá bấy nhiêu phút thì nhắc quản lý dịch vụ một lần')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "system_configs" WHERE "key" = 'checkin_face.review_sla_minutes'`);
    await queryRunner.query(`DROP TABLE IF EXISTS "checkin_face_reviews"`);
  }
}
