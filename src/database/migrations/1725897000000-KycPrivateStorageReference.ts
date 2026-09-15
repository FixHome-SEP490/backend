import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the private Supabase Storage object-path contract without rewriting
 * historical KYC migrations or pretending legacy public URLs are private.
 */
export class KycPrivateStorageReference1725897000000
  implements MigrationInterface
{
  name = 'KycPrivateStorageReference1725897000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "verification_documents"
        ADD COLUMN IF NOT EXISTS "storage_object_path" VARCHAR(512);
      ALTER TABLE "verification_documents"
        ALTER COLUMN "file_url" DROP NOT NULL;
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "verification_documents"."storage_object_path" IS
        'Private Supabase Storage object path; canonical KYC media reference';
      COMMENT ON COLUMN "verification_documents"."file_url" IS
        'Legacy public URL retained only for compatibility; not used by the application';
      CREATE INDEX IF NOT EXISTS "idx_verification_documents_storage_object_path"
        ON "verification_documents" ("storage_object_path")
        WHERE "storage_object_path" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [privateRows] = await queryRunner.query(`
      SELECT COUNT(*)::int AS count
      FROM "verification_documents"
      WHERE "storage_object_path" IS NOT NULL
    `);
    if (Number(privateRows?.count) > 0) {
      throw new Error(
        'Refusing to revert private KYC storage reference because the reversal would be lossy',
      );
    }

    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_verification_documents_storage_object_path"',
    );
    await queryRunner.query(`
      ALTER TABLE "verification_documents"
        DROP COLUMN IF EXISTS "storage_object_path";
      ALTER TABLE "verification_documents"
        ALTER COLUMN "file_url" SET NOT NULL;
    `);
  }
}
