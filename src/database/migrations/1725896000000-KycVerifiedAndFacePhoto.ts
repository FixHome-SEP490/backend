import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migrates KYC/technician eligibility semantics from APPROVED to VERIFIED
 * without rewriting historical migrations or recreating application tables.
 */
export class KycVerifiedAndFacePhoto1725896000000
  implements MigrationInterface
{
  name = 'KycVerifiedAndFacePhoto1725896000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The old partial index predicate references the old enum value.
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_one_open_verification"',
    );

    // PostgreSQL enums cannot remove APPROVED in place. Convert through a new
    // type so existing rows are mapped before the legacy type is discarded.
    await queryRunner.query(`
      CREATE TYPE "technician_verifications_status_enum_v2" AS ENUM
        ('pending', 'verified', 'rejected');
      ALTER TABLE "technician_verifications"
        ALTER COLUMN "status" DROP DEFAULT,
        ALTER COLUMN "status" TYPE "technician_verifications_status_enum_v2"
        USING (
          CASE "status"::text
            WHEN 'approved' THEN 'verified'
            ELSE "status"::text
          END
        )::"technician_verifications_status_enum_v2";
      DROP TYPE "technician_verifications_status_enum";
      ALTER TYPE "technician_verifications_status_enum_v2"
        RENAME TO "technician_verifications_status_enum";
      ALTER TABLE "technician_verifications"
        ALTER COLUMN "status" SET DEFAULT 'pending';
    `);

    // The profile was historically varchar-backed. Make its database contract
    // match the VerificationStatus enum used by the entity and query layer.
    await queryRunner.query(`
      UPDATE "technician_profiles"
      SET "verification_status" = 'verified'
      WHERE "verification_status" = 'approved';
      CREATE TYPE "technician_profiles_verification_status_enum" AS ENUM
        ('pending', 'verified', 'rejected');
      ALTER TABLE "technician_profiles"
        ALTER COLUMN "verification_status" DROP DEFAULT,
        ALTER COLUMN "verification_status" TYPE
          "technician_profiles_verification_status_enum"
        USING "verification_status"::text::"technician_profiles_verification_status_enum";
      ALTER TABLE "technician_profiles"
        ALTER COLUMN "verification_status" SET DEFAULT 'pending';
    `);

    await queryRunner.query(`
      ALTER TYPE "verification_documents_document_type_enum"
        ADD VALUE IF NOT EXISTS 'face_photo';
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_one_open_verification"
        ON "technician_verifications" ("technician_id")
        WHERE "status" IN ('pending', 'verified');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [verifiedVerifications] = await queryRunner.query(`
      SELECT COUNT(*)::int AS count
      FROM "technician_verifications"
      WHERE "status" = 'verified'
    `);
    const [verifiedProfiles] = await queryRunner.query(`
      SELECT COUNT(*)::int AS count
      FROM "technician_profiles"
      WHERE "verification_status" = 'verified'
    `);
    const [facePhotos] = await queryRunner.query(`
      SELECT COUNT(*)::int AS count
      FROM "verification_documents"
      WHERE "document_type" = 'face_photo'
    `);

    if (
      Number(verifiedVerifications?.count) > 0 ||
      Number(verifiedProfiles?.count) > 0 ||
      Number(facePhotos?.count) > 0
    ) {
      throw new Error(
        'Refusing to revert KYC VERIFIED/FACE_PHOTO data because the reversal would be lossy',
      );
    }

    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_one_open_verification"',
    );

    await queryRunner.query(`
      CREATE TYPE "technician_verifications_status_enum_legacy" AS ENUM
        ('pending', 'approved', 'rejected');
      ALTER TABLE "technician_verifications"
        ALTER COLUMN "status" DROP DEFAULT,
        ALTER COLUMN "status" TYPE
          "technician_verifications_status_enum_legacy"
        USING "status"::text::"technician_verifications_status_enum_legacy";
      DROP TYPE "technician_verifications_status_enum";
      ALTER TYPE "technician_verifications_status_enum_legacy"
        RENAME TO "technician_verifications_status_enum";
      ALTER TABLE "technician_verifications"
        ALTER COLUMN "status" SET DEFAULT 'pending';
    `);

    await queryRunner.query(`
      CREATE TYPE "verification_documents_document_type_enum_legacy" AS ENUM
        ('citizen_id_front', 'citizen_id_back', 'certificate', 'portfolio', 'other');
      ALTER TABLE "verification_documents"
        ALTER COLUMN "document_type" TYPE
          "verification_documents_document_type_enum_legacy"
        USING "document_type"::text::"verification_documents_document_type_enum_legacy";
      DROP TYPE "verification_documents_document_type_enum";
      ALTER TYPE "verification_documents_document_type_enum_legacy"
        RENAME TO "verification_documents_document_type_enum";
    `);

    await queryRunner.query(`
      ALTER TABLE "technician_profiles"
        ALTER COLUMN "verification_status" DROP DEFAULT,
        ALTER COLUMN "verification_status" TYPE varchar(32)
        USING "verification_status"::text;
      DROP TYPE "technician_profiles_verification_status_enum";
      ALTER TABLE "technician_profiles"
        ALTER COLUMN "verification_status" SET DEFAULT 'pending';
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_one_open_verification"
        ON "technician_verifications" ("technician_id")
        WHERE "status" IN ('pending', 'approved');
    `);
  }
}
