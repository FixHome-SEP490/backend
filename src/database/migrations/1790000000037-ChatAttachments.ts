import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 18/10/2026: the customer and the technician send photos and short videos in
 * their chat. One file per message, kept private: the row holds the storage
 * reference and the type and size read from the file's bytes, never a public URL.
 */
export class ChatAttachments1790000000037 implements MigrationInterface {
  name = 'ChatAttachments1790000000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "attachment_kind" varchar(10) NULL`);
    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "attachment_ref" varchar(500) NULL`);
    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "attachment_mime" varchar(30) NULL`);
    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "attachment_size" integer NULL`);
    await queryRunner.query(`ALTER TABLE "messages" ADD CONSTRAINT "ck_messages_attachment_kind" CHECK ("attachment_kind" IS NULL OR "attachment_kind" IN ('image', 'video'))`);
    await queryRunner.query(`ALTER TABLE "messages" ADD CONSTRAINT "ck_messages_attachment_complete" CHECK (("attachment_kind" IS NULL) = ("attachment_ref" IS NULL) AND ("attachment_kind" IS NULL) = ("attachment_mime" IS NULL))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "ck_messages_attachment_complete"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "ck_messages_attachment_kind"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "attachment_size"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "attachment_mime"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "attachment_ref"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "attachment_kind"`);
  }
}
