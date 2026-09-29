import { MigrationInterface, QueryRunner } from 'typeorm';

export class ManagerReviewFields1790000000016 implements MigrationInterface {
  name = 'ManagerReviewFields1790000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "warranty_claims"
        ADD COLUMN IF NOT EXISTS "final_result" varchar(32),
        ADD COLUMN IF NOT EXISTS "final_reason_code" varchar(40),
        ADD COLUMN IF NOT EXISTS "sm_overrode_proposal" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "reviewed_by_manager_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz;

      ALTER TABLE "support_cases"
        ADD COLUMN IF NOT EXISTS "hold_completion" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "liable_party" varchar(16),
        ADD COLUMN IF NOT EXISTS "amount" bigint;

      CREATE INDEX IF NOT EXISTS "idx_support_cases_hold_completion"
        ON "support_cases" ("service_order_id") WHERE "hold_completion" = true;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_support_cases_hold_completion";
      ALTER TABLE "support_cases"
        DROP COLUMN IF EXISTS "amount",
        DROP COLUMN IF EXISTS "liable_party",
        DROP COLUMN IF EXISTS "hold_completion";
      ALTER TABLE "warranty_claims"
        DROP COLUMN IF EXISTS "reviewed_at",
        DROP COLUMN IF EXISTS "reviewed_by_manager_id",
        DROP COLUMN IF EXISTS "sm_overrode_proposal",
        DROP COLUMN IF EXISTS "final_reason_code",
        DROP COLUMN IF EXISTS "final_result";
    `);
  }
}
