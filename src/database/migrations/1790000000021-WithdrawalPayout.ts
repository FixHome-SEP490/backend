import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Automatic withdrawal payouts through payOS.
 *
 * Purely additive, so code that predates it keeps running against the shared
 * database: a new table, nullable columns, and the one-open-withdrawal index
 * widened to cover payouts still in flight.
 *
 * The index names only the statuses that close a withdrawal, never PROCESSING.
 * WithdrawalPayoutEnums1790000000020 adds PROCESSING, and whether its commit
 * lands before this migration depends on the runner: the CLI runs one
 * transaction per migration, DataSource.runMigrations() defaults to a single
 * transaction for all of them, and PostgreSQL refuses a new enum value inside
 * the transaction that added it. "Not closed" means the same thing as
 * "PENDING or PROCESSING" and works under both.
 */
export class WithdrawalPayout1790000000021 implements MigrationInterface {
  name = 'WithdrawalPayout1790000000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "technician_bank_accounts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "technician_id" UUID NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
        "bank_bin" VARCHAR(8) NOT NULL,
        "bank_code" VARCHAR(32) NOT NULL,
        "bank_name" VARCHAR(128) NOT NULL,
        "account_number" VARCHAR(32) NOT NULL,
        "account_name" VARCHAR(128) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      ALTER TABLE "withdrawal_requests"
        ADD COLUMN IF NOT EXISTS "bank_bin" VARCHAR(8),
        ADD COLUMN IF NOT EXISTS "payout_id" VARCHAR(64),
        ADD COLUMN IF NOT EXISTS "payout_state" VARCHAR(32),
        ADD COLUMN IF NOT EXISTS "payout_bank_reference" VARCHAR(128),
        ADD COLUMN IF NOT EXISTS "payout_attempted_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "failure_reason" TEXT,
        ADD COLUMN IF NOT EXISTS "refund_transaction_id" UUID
          REFERENCES "wallet_transactions"("id") ON DELETE SET NULL;
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_pending_withdrawal_per_wallet";
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_pending_withdrawal_per_wallet"
        ON "withdrawal_requests"("wallet_id")
        WHERE "status" NOT IN ('SUCCESS', 'REJECTED', 'FAILED');
    `);

    await queryRunner.query(`
      ALTER TABLE "technician_verifications"
        ADD COLUMN IF NOT EXISTS "verified_full_name" VARCHAR(255);
    `);
    // KYC approved before this column existed: the current profile name is the
    // best record there is. Everything approved from now on is captured at the
    // moment of approval instead.
    await queryRunner.query(`
      UPDATE "technician_verifications" tv
         SET "verified_full_name" = u."full_name"
        FROM "users" u
       WHERE u."id" = tv."technician_id"
         AND tv."status" = 'verified'
         AND tv."verified_full_name" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "technician_verifications" DROP COLUMN IF EXISTS "verified_full_name";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_pending_withdrawal_per_wallet";
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_pending_withdrawal_per_wallet"
        ON "withdrawal_requests"("wallet_id")
        WHERE "status" = 'PENDING';
    `);
    await queryRunner.query(`
      ALTER TABLE "withdrawal_requests"
        DROP COLUMN IF EXISTS "refund_transaction_id",
        DROP COLUMN IF EXISTS "failure_reason",
        DROP COLUMN IF EXISTS "payout_attempted_at",
        DROP COLUMN IF EXISTS "payout_bank_reference",
        DROP COLUMN IF EXISTS "payout_state",
        DROP COLUMN IF EXISTS "payout_id",
        DROP COLUMN IF EXISTS "bank_bin";
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "technician_bank_accounts";`);
  }
}
