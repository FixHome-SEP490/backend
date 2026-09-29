import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Brings `warranty_claims` in line with the WarrantyClaim entity.
 * The original table (SpecV12) used different columns and status labels and
 * could never accept an insert from the application; it held no rows when this
 * was written. Legacy columns are relaxed, not dropped, so nothing is lost.
 */
export class WarrantyClaimReconcile1790000000014 implements MigrationInterface {
  name = 'WarrantyClaimReconcile1790000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "warranty_claims"
        ALTER COLUMN "claim_reason" DROP NOT NULL,
        ALTER COLUMN "issue_description" DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS "technician_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS "description" text,
        ADD COLUMN IF NOT EXISTS "submitted_at" timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS "resolved_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "resolution_notes" text,
        ADD COLUMN IF NOT EXISTS "evidence_refs" jsonb,
        ADD COLUMN IF NOT EXISTS "submitted_after_expiry" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "customer_response" varchar(16),
        ADD COLUMN IF NOT EXISTS "customer_responded_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "escalated_support_case_id" uuid REFERENCES "support_cases"("id") ON DELETE SET NULL;

      UPDATE "warranty_claims"
      SET "description" = COALESCE("issue_description", "claim_reason", ''),
          "submitted_at" = "created_at"
      WHERE "description" IS NULL;

      ALTER TABLE "warranty_claims" ALTER COLUMN "description" SET NOT NULL;

      ALTER TABLE "warranty_claims" ALTER COLUMN "status" DROP DEFAULT;
      ALTER TYPE "warranty_claim_status_enum" RENAME TO "warranty_claim_status_enum_old";
      CREATE TYPE "warranty_claim_status_enum" AS ENUM (
        'submitted', 'accepted', 'inspected', 'in_progress',
        'awaiting_customer', 'disputed', 'resolved', 'rejected'
      );
      ALTER TABLE "warranty_claims"
        ALTER COLUMN "status" TYPE "warranty_claim_status_enum"
        USING (CASE "status"::text
          WHEN 'open' THEN 'submitted'
          WHEN 'reviewing' THEN 'accepted'
          WHEN 'rework' THEN 'in_progress'
          ELSE "status"::text
        END)::"warranty_claim_status_enum";
      ALTER TABLE "warranty_claims" ALTER COLUMN "status" SET DEFAULT 'submitted';
      DROP TYPE "warranty_claim_status_enum_old";

      CREATE INDEX IF NOT EXISTS "idx_warranty_claims_coverage_status"
        ON "warranty_claims" ("warranty_coverage_id", "status");
      CREATE INDEX IF NOT EXISTS "idx_warranty_claims_technician_status"
        ON "warranty_claims" ("technician_id", "status");
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Not reversible: status labels were remapped and the old enum dropped.
  }
}
