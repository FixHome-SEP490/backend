import { MigrationInterface, QueryRunner } from 'typeorm';

export class TechnicianWalletCore1790000000008 implements MigrationInterface {
  name = 'TechnicianWalletCore1790000000008';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DO $$ BEGIN
        CREATE TYPE "wallet_transaction_type_enum" AS ENUM (
          'TOP_UP',
          'WITHDRAW',
          'ONLINE_EARNING',
          'PLATFORM_FEE',
          'ADJUSTMENT'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      DO $$ BEGIN
        CREATE TYPE "withdrawal_status_enum" AS ENUM (
          'PENDING',
          'SUCCESS',
          'REJECTED',
          'FAILED'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      CREATE TABLE IF NOT EXISTS "wallets" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "technician_id" UUID NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE RESTRICT,
        "balance" BIGINT NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS "idx_wallets_technician_id" ON "wallets"("technician_id");
      CREATE INDEX IF NOT EXISTS "idx_wallets_balance" ON "wallets"("balance");

      CREATE TABLE IF NOT EXISTS "wallet_transactions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "wallet_id" UUID NOT NULL REFERENCES "wallets"("id") ON DELETE RESTRICT,
        "type" "wallet_transaction_type_enum" NOT NULL,
        "amount" BIGINT NOT NULL,
        "balance_before" BIGINT NOT NULL,
        "balance_after" BIGINT NOT NULL,
        "reference_type" VARCHAR(64) NULL,
        "reference_id" VARCHAR(128) NULL,
        "idempotency_key" VARCHAR(128) NOT NULL UNIQUE,
        "description" TEXT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS "idx_wallet_tx_wallet_created" ON "wallet_transactions"("wallet_id", "created_at" DESC);
      CREATE INDEX IF NOT EXISTS "idx_wallet_tx_type" ON "wallet_transactions"("type");
      CREATE INDEX IF NOT EXISTS "idx_wallet_tx_ref" ON "wallet_transactions"("reference_type", "reference_id");

      CREATE TABLE IF NOT EXISTS "withdrawal_requests" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "wallet_id" UUID NOT NULL REFERENCES "wallets"("id") ON DELETE RESTRICT,
        "technician_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "amount" BIGINT NOT NULL,
        "bank_name" VARCHAR(128) NULL,
        "bank_account_number" VARCHAR(64) NULL,
        "bank_account_name" VARCHAR(128) NULL,
        "status" "withdrawal_status_enum" NOT NULL DEFAULT 'PENDING',
        "requested_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "processed_at" TIMESTAMPTZ NULL,
        "processed_by_user_id" UUID NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "reject_reason" TEXT NULL,
        "transaction_id" UUID NULL REFERENCES "wallet_transactions"("id") ON DELETE SET NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "uq_pending_withdrawal_per_wallet" 
        ON "withdrawal_requests"("wallet_id") 
        WHERE "status" = 'PENDING';

      CREATE INDEX IF NOT EXISTS "idx_withdrawal_technician" ON "withdrawal_requests"("technician_id", "created_at" DESC);
      CREATE INDEX IF NOT EXISTS "idx_withdrawal_status" ON "withdrawal_requests"("status");

      -- Seed wallet for existing technicians with default balance 200,000 VND so they remain eligible
      INSERT INTO "wallets" ("technician_id", "balance")
      SELECT u.id, 200000
      FROM "users" u
      WHERE u.role = 'technician'
      ON CONFLICT ("technician_id") DO NOTHING;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DROP TABLE IF EXISTS "withdrawal_requests" CASCADE;
      DROP TABLE IF EXISTS "wallet_transactions" CASCADE;
      DROP TABLE IF EXISTS "wallets" CASCADE;
      DROP TYPE IF EXISTS "withdrawal_status_enum";
      DROP TYPE IF EXISTS "wallet_transaction_type_enum";
    `);
  }
}
