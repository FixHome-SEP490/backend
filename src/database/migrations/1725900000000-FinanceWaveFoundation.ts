import { MigrationInterface, QueryRunner } from 'typeorm';

export class FinanceWaveFoundation1725900000000 implements MigrationInterface {
  name = 'FinanceWaveFoundation1725900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_mode_enum') THEN
          CREATE TYPE payment_mode_enum AS ENUM ('DEMO', 'LIVE');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_purpose_enum') THEN
          CREATE TYPE payment_purpose_enum AS ENUM ('invoice', 'commission_due');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_attempt_status_enum') THEN
          CREATE TYPE payment_attempt_status_enum AS ENUM ('pending', 'verified', 'failed', 'refunded', 'cancelled');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'platform_due_status_enum') THEN
          CREATE TYPE platform_due_status_enum AS ENUM ('pending', 'settled', 'cancelled');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "commission_dues"
        ADD COLUMN IF NOT EXISTS "payment_reference" TEXT;

      ALTER TABLE "cash_settlements"
        ADD COLUMN IF NOT EXISTS "dispute_reason" TEXT,
        ADD COLUMN IF NOT EXISTS "disputed_by_customer_id" UUID,
        ADD COLUMN IF NOT EXISTS "disputed_at" TIMESTAMPTZ;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_cash_settlements_disputed_by_customer'
        ) THEN
          ALTER TABLE "cash_settlements"
            ADD CONSTRAINT "fk_cash_settlements_disputed_by_customer"
            FOREIGN KEY ("disputed_by_customer_id") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payments" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoice_id" UUID REFERENCES "invoices"("id") ON DELETE RESTRICT,
        "commission_due_id" UUID REFERENCES "commission_dues"("id") ON DELETE RESTRICT,
        "purpose" payment_purpose_enum NOT NULL,
        "amount" BIGINT NOT NULL,
        "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
        "mode" payment_mode_enum NOT NULL,
        "provider" VARCHAR(64),
        "status" payment_attempt_status_enum NOT NULL DEFAULT 'pending',
        "idempotency_key" VARCHAR(128) NOT NULL,
        "provider_reference" VARCHAR(255),
        "requested_by_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "failure_code" VARCHAR(64),
        "requested_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "verified_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_payments_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "chk_payments_positive_amount" CHECK ("amount" >= 0),
        CONSTRAINT "chk_payments_vnd_only" CHECK ("currency" = 'VND'),
        CONSTRAINT "chk_payments_one_target" CHECK (
          (CASE WHEN "invoice_id" IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN "commission_due_id" IS NOT NULL THEN 1 ELSE 0 END) = 1
        )
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_payments_provider_reference"
        ON "payments" ("provider_reference")
        WHERE "provider_reference" IS NOT NULL;
      CREATE INDEX IF NOT EXISTS "idx_payments_invoice_created_at"
        ON "payments" ("invoice_id", "created_at");
      CREATE INDEX IF NOT EXISTS "idx_payments_commission_due_created_at"
        ON "payments" ("commission_due_id", "created_at");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_dues" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoice_id" UUID NOT NULL REFERENCES "invoices"("id") ON DELETE RESTRICT,
        "service_order_id" UUID NOT NULL REFERENCES "service_orders"("id") ON DELETE RESTRICT,
        "labor_total_snapshot" BIGINT NOT NULL,
        "fixhome_parts_total_snapshot" BIGINT NOT NULL,
        "commission_rate_snapshot" NUMERIC(5, 4) NOT NULL,
        "commission_amount_snapshot" BIGINT NOT NULL,
        "due_amount" BIGINT NOT NULL,
        "status" platform_due_status_enum NOT NULL DEFAULT 'pending',
        "settled_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_platform_due_order" UNIQUE ("service_order_id"),
        CONSTRAINT "chk_platform_due_amounts" CHECK (
          "labor_total_snapshot" >= 0 AND
          "fixhome_parts_total_snapshot" >= 0 AND
          "commission_amount_snapshot" >= 0 AND
          "due_amount" >= 0
        )
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_platform_dues_status_created_at"
        ON "platform_dues" ("status", "created_at");
      CREATE INDEX IF NOT EXISTS "idx_platform_dues_invoice_id"
        ON "platform_dues" ("invoice_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "platform_dues";');
    await queryRunner.query('DROP TABLE IF EXISTS "payments";');
    await queryRunner.query(`
      ALTER TABLE "cash_settlements"
        DROP COLUMN IF EXISTS "disputed_at",
        DROP COLUMN IF EXISTS "disputed_by_customer_id",
        DROP COLUMN IF EXISTS "dispute_reason";
    `);
    await queryRunner.query(`
      ALTER TABLE "commission_dues"
        DROP COLUMN IF EXISTS "payment_reference";
    `);
    await queryRunner.query('DROP TYPE IF EXISTS platform_due_status_enum;');
    await queryRunner.query('DROP TYPE IF EXISTS payment_attempt_status_enum;');
    await queryRunner.query('DROP TYPE IF EXISTS payment_purpose_enum;');
    await queryRunner.query('DROP TYPE IF EXISTS payment_mode_enum;');
  }
}
