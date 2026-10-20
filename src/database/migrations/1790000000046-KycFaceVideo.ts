import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hồ sơ xác minh của thợ nhận video khuôn mặt (web gửi `face_video`, video/webm
 * hoặc video/mp4 từ 25/09/2026). Thêm giá trị enum nếu chưa có và mở bucket KYC
 * cho hai loại video; giới hạn 10 MB giữ nguyên.
 */
export class KycFaceVideo1790000000046 implements MigrationInterface {
  name = 'KycFaceVideo1790000000046';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "verification_documents_document_type_enum" ADD VALUE IF NOT EXISTS 'face_video'`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
          UPDATE storage.buckets
          SET "allowed_mime_types" = ARRAY(
            SELECT DISTINCT unnest(coalesce("allowed_mime_types", ARRAY[]::text[]) || ARRAY['video/webm', 'video/mp4'])
          )
          WHERE "id" = 'kyc-private';
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres không gỡ được giá trị enum; chỉ đóng bucket lại khi chưa có video nào.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
          IF EXISTS (SELECT 1 FROM "verification_documents" WHERE "document_type" = 'face_video') THEN
            RAISE EXCEPTION 'Face videos exist; refusing to remove video types from the KYC bucket';
          END IF;
          UPDATE storage.buckets
          SET "allowed_mime_types" = ARRAY(
            SELECT m FROM unnest("allowed_mime_types") AS m WHERE m NOT IN ('video/webm', 'video/mp4')
          )
          WHERE "id" = 'kyc-private';
        END IF;
      END $$;
    `);
  }
}
