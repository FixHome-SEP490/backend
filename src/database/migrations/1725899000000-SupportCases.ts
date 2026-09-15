import { MigrationInterface, QueryRunner } from 'typeorm';

export class SupportCases1725899000000 implements MigrationInterface {
  name = 'SupportCases1725899000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'support_case_type_enum') THEN
          CREATE TYPE "support_case_type_enum" AS ENUM (
            'matching_exhausted',
            'arrival_abnormal',
            'cash_non_response',
            'cash_mismatch',
            'cancellation_review',
            'parts_dispute',
            'warranty_dispute',
            'mid_job_interruption',
            'other'
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'support_case_status_enum') THEN
          CREATE TYPE "support_case_status_enum" AS ENUM (
            'open',
            'in_review',
            'resolved',
            'rejected'
          );
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "support_cases" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "case_type" "support_case_type_enum" NOT NULL,
        "status" "support_case_status_enum" NOT NULL DEFAULT 'open',
        "booking_id" UUID,
        "service_order_id" UUID,
        "customer_id" UUID,
        "technician_id" UUID,
        "created_by_user_id" UUID,
        "assigned_manager_id" UUID,
        "reason" VARCHAR(2000) NOT NULL,
        "description" VARCHAR(5000),
        "resolution_code" VARCHAR(128),
        "resolution_reason" VARCHAR(2000),
        "evidence_refs" JSONB,
        "resolved_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "chk_support_cases_reason_length"
          CHECK (length(btrim("reason")) BETWEEN 1 AND 2000),
        CONSTRAINT "chk_support_cases_description_length"
          CHECK ("description" IS NULL OR length(btrim("description")) BETWEEN 1 AND 5000),
        CONSTRAINT "chk_support_cases_resolution_code_length"
          CHECK ("resolution_code" IS NULL OR length(btrim("resolution_code")) BETWEEN 1 AND 128),
        CONSTRAINT "chk_support_cases_resolution_reason_length"
          CHECK ("resolution_reason" IS NULL OR length(btrim("resolution_reason")) BETWEEN 1 AND 2000),
        CONSTRAINT "chk_support_cases_evidence_refs_array"
          CHECK ("evidence_refs" IS NULL OR jsonb_typeof("evidence_refs") = 'array'),
        CONSTRAINT "chk_support_cases_terminal_resolution"
          CHECK (
            ("status" IN ('resolved', 'rejected') AND "resolved_at" IS NOT NULL)
            OR ("status" IN ('open', 'in_review') AND "resolved_at" IS NULL)
          ),
        CONSTRAINT "fk_support_cases_booking"
          FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_support_cases_service_order"
          FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_support_cases_customer"
          FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_support_cases_technician"
          FOREIGN KEY ("technician_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_support_cases_created_by_user"
          FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_support_cases_assigned_manager"
          FOREIGN KEY ("assigned_manager_id") REFERENCES "users"("id") ON DELETE SET NULL
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_support_cases_status_created_at"
        ON "support_cases" ("status", "created_at");
      CREATE INDEX IF NOT EXISTS "idx_support_cases_case_type_created_at"
        ON "support_cases" ("case_type", "created_at");
      CREATE INDEX IF NOT EXISTS "idx_support_cases_service_order_id"
        ON "support_cases" ("service_order_id");
      CREATE INDEX IF NOT EXISTS "idx_support_cases_booking_id"
        ON "support_cases" ("booking_id");
      CREATE INDEX IF NOT EXISTS "idx_support_cases_assigned_manager_id"
        ON "support_cases" ("assigned_manager_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "support_cases";');
    await queryRunner.query('DROP TYPE IF EXISTS "support_case_status_enum";');
    await queryRunner.query('DROP TYPE IF EXISTS "support_case_type_enum";');
  }
}
