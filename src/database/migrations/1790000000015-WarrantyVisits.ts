import { MigrationInterface, QueryRunner } from 'typeorm';

export class WarrantyVisits1790000000015 implements MigrationInterface {
  name = 'WarrantyVisits1790000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "warranty_claims"
        ADD COLUMN IF NOT EXISTS "awaiting_prompt" varchar(16),
        ADD COLUMN IF NOT EXISTS "declined_by_technician_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS "decline_reason_code" varchar(32),
        ADD COLUMN IF NOT EXISTS "decline_note" text,
        ADD COLUMN IF NOT EXISTS "declined_at" timestamptz;

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'warranty_visit_status_enum') THEN
          CREATE TYPE "warranty_visit_status_enum" AS ENUM
            ('scheduled', 'checked_in', 'inspected', 'completed', 'cancelled');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'warranty_inspection_result_enum') THEN
          CREATE TYPE "warranty_inspection_result_enum" AS ENUM
            ('covered_workmanship', 'covered_part', 'not_covered');
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS "warranty_visits" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "warranty_claim_id" uuid NOT NULL REFERENCES "warranty_claims"("id") ON DELETE CASCADE,
        "technician_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "status" "warranty_visit_status_enum" NOT NULL DEFAULT 'scheduled',
        "scheduled_at" timestamptz,
        "checked_in_at" timestamptz,
        "check_in_lat" numeric(10,7),
        "check_in_lng" numeric(10,7),
        "proposed_result" "warranty_inspection_result_enum",
        "not_covered_reason_code" varchar(40),
        "findings" text,
        "evidence_refs" jsonb,
        "re_service_notes" text,
        "re_service_evidence_refs" jsonb,
        "completed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS "idx_warranty_visits_claim_status"
        ON "warranty_visits" ("warranty_claim_id", "status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS "warranty_visits";
      DROP TYPE IF EXISTS "warranty_inspection_result_enum";
      DROP TYPE IF EXISTS "warranty_visit_status_enum";
      ALTER TABLE "warranty_claims"
        DROP COLUMN IF EXISTS "declined_at",
        DROP COLUMN IF EXISTS "decline_note",
        DROP COLUMN IF EXISTS "decline_reason_code",
        DROP COLUMN IF EXISTS "declined_by_technician_id",
        DROP COLUMN IF EXISTS "awaiting_prompt";
    `);
  }
}
