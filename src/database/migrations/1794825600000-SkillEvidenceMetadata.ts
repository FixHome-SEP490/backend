import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 23/11/2026: a technician's evidence for one skill carries structured metadata (type, trust group, issuer,
 * reference number, issue/expiry date, claimed years) so the reviewer can estimate the level from evidence.
 * Additive: nine nullable columns on the existing verification_documents (no new table). Old rows and the
 * identity-KYC rows keep NULL. CHECKs keep the data consistent without making the fields mandatory yet,
 * so clients that do not send them keep working.
 */
export class SkillEvidenceMetadata1794825600000 implements MigrationInterface {
  name = 'SkillEvidenceMetadata1794825600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "verification_documents"
        ADD COLUMN IF NOT EXISTS "evidence_type" varchar(40) NULL,
        ADD COLUMN IF NOT EXISTS "evidence_group" varchar(20) NULL,
        ADD COLUMN IF NOT EXISTS "issuer" varchar(200) NULL,
        ADD COLUMN IF NOT EXISTS "reference_number" varchar(100) NULL,
        ADD COLUMN IF NOT EXISTS "issued_at" date NULL,
        ADD COLUMN IF NOT EXISTS "expires_at" date NULL,
        ADD COLUMN IF NOT EXISTS "claimed_years" int NULL,
        ADD COLUMN IF NOT EXISTS "review_status" varchar(20) NULL,
        ADD COLUMN IF NOT EXISTS "review_note" text NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "verification_documents"
        ADD CONSTRAINT "chk_vd_evidence_type" CHECK ("evidence_type" IS NULL OR "evidence_type" IN
          ('national_skill_certificate','vocational_diploma','electrical_safety_card','manufacturer_training',
           'employer_confirmation','social_insurance','work_photos','other')),
        ADD CONSTRAINT "chk_vd_evidence_group" CHECK ("evidence_group" IS NULL OR "evidence_group" IN
          ('official','verifiable','self_declared')),
        ADD CONSTRAINT "chk_vd_evidence_group_with_type" CHECK (("evidence_type" IS NULL) = ("evidence_group" IS NULL)),
        ADD CONSTRAINT "chk_vd_review_status" CHECK ("review_status" IS NULL OR "review_status" IN
          ('pending','valid','invalid','need_more')),
        ADD CONSTRAINT "chk_vd_claimed_years" CHECK ("claimed_years" IS NULL OR ("claimed_years" BETWEEN 0 AND 60)),
        ADD CONSTRAINT "chk_vd_evidence_dates" CHECK ("issued_at" IS NULL OR "expires_at" IS NULL OR "expires_at" >= "issued_at"),
        ADD CONSTRAINT "chk_vd_review_note_length" CHECK ("review_note" IS NULL OR char_length("review_note") <= 1000),
        ADD CONSTRAINT "chk_vd_evidence_skill_only" CHECK ("skill_verification_id" IS NOT NULL OR (
          "evidence_type" IS NULL AND "issuer" IS NULL AND "reference_number" IS NULL AND "issued_at" IS NULL
          AND "expires_at" IS NULL AND "claimed_years" IS NULL AND "review_status" IS NULL AND "review_note" IS NULL))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "verification_documents"
        DROP CONSTRAINT IF EXISTS "chk_vd_evidence_skill_only",
        DROP CONSTRAINT IF EXISTS "chk_vd_review_note_length",
        DROP CONSTRAINT IF EXISTS "chk_vd_evidence_dates",
        DROP CONSTRAINT IF EXISTS "chk_vd_claimed_years",
        DROP CONSTRAINT IF EXISTS "chk_vd_review_status",
        DROP CONSTRAINT IF EXISTS "chk_vd_evidence_group_with_type",
        DROP CONSTRAINT IF EXISTS "chk_vd_evidence_group",
        DROP CONSTRAINT IF EXISTS "chk_vd_evidence_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "verification_documents"
        DROP COLUMN IF EXISTS "review_note",
        DROP COLUMN IF EXISTS "review_status",
        DROP COLUMN IF EXISTS "claimed_years",
        DROP COLUMN IF EXISTS "expires_at",
        DROP COLUMN IF EXISTS "issued_at",
        DROP COLUMN IF EXISTS "reference_number",
        DROP COLUMN IF EXISTS "issuer",
        DROP COLUMN IF EXISTS "evidence_group",
        DROP COLUMN IF EXISTS "evidence_type"
    `);
  }
}
