import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Skill verification: a technician's declared skill (technician_skills) is no
 * longer auto-bookable just by toggling isActive. Each skill carries its own
 * verification_status, backed by a review history in
 * technician_skill_verifications (mirrors technician_verifications/KYC).
 * verification_documents is reused (not duplicated) for the evidence files:
 * skill_verification_id is a second, mutually-exclusive owner column, and
 * issued_by distinguishes a technician-submitted external credential (NULL)
 * from a certificate FixHome itself issued at approval time (admin user id).
 */
export class TechnicianSkillVerification1726900000000
  implements MigrationInterface
{
  name = 'TechnicianSkillVerification1726900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "technician_skill_verifications_status_enum" AS ENUM
        ('pending', 'verified', 'rejected');
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "technician_skill_verifications" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "technician_skill_id" uuid NOT NULL,
        "status" "technician_skill_verifications_status_enum" NOT NULL DEFAULT 'pending',
        "submitted_at" timestamptz NOT NULL DEFAULT now(),
        "reviewed_at" timestamptz NULL,
        "reviewed_by" uuid NULL,
        "rejection_reason" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_tech_skill_verifications_skill" FOREIGN KEY ("technician_skill_id") REFERENCES "technician_skills" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_tech_skill_verifications_reviewed_by" FOREIGN KEY ("reviewed_by") REFERENCES "users" ("id") ON DELETE SET NULL
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tech_skill_verifications_skill" ON "technician_skill_verifications" ("technician_skill_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tech_skill_verifications_status" ON "technician_skill_verifications" ("status");
    `);
    // Only one open (pending/verified) verification per skill at a time.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_one_open_skill_verification"
        ON "technician_skill_verifications" ("technician_skill_id")
        WHERE "status" IN ('pending', 'verified');
    `);

    await queryRunner.query(`
      ALTER TABLE "verification_documents"
        ALTER COLUMN "verification_id" DROP NOT NULL,
        ADD COLUMN "skill_verification_id" uuid NULL,
        ADD COLUMN "issued_by" uuid NULL,
        ADD CONSTRAINT "fk_verification_documents_skill_verification"
          FOREIGN KEY ("skill_verification_id") REFERENCES "technician_skill_verifications" ("id") ON DELETE CASCADE,
        ADD CONSTRAINT "fk_verification_documents_issued_by"
          FOREIGN KEY ("issued_by") REFERENCES "users" ("id") ON DELETE SET NULL,
        ADD CONSTRAINT "chk_verification_documents_one_owner"
          CHECK (
            ("verification_id" IS NOT NULL AND "skill_verification_id" IS NULL) OR
            ("verification_id" IS NULL AND "skill_verification_id" IS NOT NULL)
          );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_verification_documents_skill_verification_id" ON "verification_documents" ("skill_verification_id");
    `);

    await queryRunner.query(`
      ALTER TABLE "technician_skills"
        ADD COLUMN "verification_status" "technician_skill_verifications_status_enum" NOT NULL DEFAULT 'pending';
    `);
    // Backfill: existing self-declared active skills predate this feature and
    // already power live bookings — grandfather them in as verified instead
    // of silently pulling every technician's services out of matching.
    await queryRunner.query(`
      UPDATE "technician_skills" SET "verification_status" = 'verified' WHERE "is_active" = true;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [skillDocs] = await queryRunner.query(`
      SELECT COUNT(*)::int AS count FROM "verification_documents" WHERE "skill_verification_id" IS NOT NULL
    `);
    if (Number(skillDocs?.count) > 0) {
      throw new Error(
        'Refusing to revert: verification_documents rows reference skill_verification_id',
      );
    }

    await queryRunner.query(`
      ALTER TABLE "technician_skills" DROP COLUMN "verification_status";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_verification_documents_skill_verification_id";
    `);
    await queryRunner.query(`
      ALTER TABLE "verification_documents"
        DROP CONSTRAINT IF EXISTS "chk_verification_documents_one_owner",
        DROP CONSTRAINT IF EXISTS "fk_verification_documents_issued_by",
        DROP CONSTRAINT IF EXISTS "fk_verification_documents_skill_verification",
        DROP COLUMN "issued_by",
        DROP COLUMN "skill_verification_id",
        ALTER COLUMN "verification_id" SET NOT NULL;
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "technician_skill_verifications";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "technician_skill_verifications_status_enum";`);
  }
}
