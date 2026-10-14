import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 14/10/2026: a customer withdraws the customer wallet to their own bank
 * account, paid out at once through payOS like a technician withdrawal. Before
 * saving a bank account or withdrawing they need an approved identity check
 * (citizen ID card front and back, reviewed by an admin).
 *
 * Kept in tables of their own so the technician KYC, bank account and
 * withdrawal tables, their constraints and their code stay untouched.
 */
export class CustomerWithdrawalKyc1790000000036 implements MigrationInterface {
  name = 'CustomerWithdrawalKyc1790000000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The address on the ID card, confirmed by the customer at KYC. Users had
    // no address column of their own (technicians keep theirs on the profile).
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "full_address" varchar(500) NULL`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "customer_verifications" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "customer_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "status" varchar(16) NOT NULL DEFAULT 'pending'
          CHECK ("status" IN ('pending', 'verified', 'rejected')),
        "full_name" varchar(200) NOT NULL,
        "date_of_birth" date NOT NULL,
        "gender" varchar(10) NOT NULL CHECK ("gender" IN ('male', 'female', 'other')),
        "citizen_id_number" varchar(12) NOT NULL CHECK ("citizen_id_number" ~ '^[0-9]{12}$'),
        "full_address" varchar(500) NOT NULL,
        "submitted_at" timestamptz NOT NULL DEFAULT now(),
        "reviewed_at" timestamptz NULL,
        "reviewed_by" UUID NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "rejection_reason" text NULL,
        "verified_full_name" varchar(255) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_customer_verification_rejection_reason"
          CHECK ("status" <> 'rejected' OR "rejection_reason" IS NOT NULL)
      )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_customer_verification_customer" ON "customer_verifications" ("customer_id", "submitted_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_customer_verification_status" ON "customer_verifications" ("status", "submitted_at")`);
    // At most one submission under review or approved per customer; a rejected
    // one stays as history and a new one may follow.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_verification_open"
        ON "customer_verifications" ("customer_id")
        WHERE "status" IN ('pending', 'verified')`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "customer_verification_documents" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "verification_id" UUID NOT NULL REFERENCES "customer_verifications"("id") ON DELETE CASCADE,
        "document_type" varchar(32) NOT NULL
          CHECK ("document_type" IN ('citizen_id_front', 'citizen_id_back')),
        "storage_object_path" varchar(512) NOT NULL,
        "file_name" varchar(255) NOT NULL,
        "file_size" integer NOT NULL CHECK ("file_size" > 0 AND "file_size" <= 10485760),
        "mime_type" varchar(32) NOT NULL
          CHECK ("mime_type" IN ('image/jpeg', 'image/png', 'image/webp')),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_customer_verification_document_type" UNIQUE ("verification_id", "document_type")
      )`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "customer_bank_accounts" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "customer_id" UUID NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
        "bank_bin" varchar(8) NOT NULL,
        "bank_code" varchar(32) NOT NULL,
        "bank_name" varchar(128) NOT NULL,
        "account_number" varchar(32) NOT NULL,
        "account_name" varchar(128) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);

    // Customer wallet ledger: the debit for a withdrawal and its refund when
    // the payout fails.
    await queryRunner.query(`ALTER TABLE "customer_wallet_transactions" DROP CONSTRAINT IF EXISTS "customer_wallet_transactions_type_check"`);
    await queryRunner.query(`
      ALTER TABLE "customer_wallet_transactions" ADD CONSTRAINT "customer_wallet_transactions_type_check"
        CHECK ("type" IN ('top_up', 'invoice_payment', 'refund', 'adjustment_credit', 'adjustment_debit', 'withdrawal', 'withdrawal_refund'))
    `);

    // Mirrors withdrawal_requests, minus the approval columns: customer
    // withdrawals are paid out immediately, so they are only ever PROCESSING,
    // SUCCESS or FAILED. The status is plain text with a CHECK rather than
    // withdrawal_status_enum: PROCESSING was added to that enum by migration
    // 0020, and a fresh database running every migration in one transaction
    // (DataSource.runMigrations, as the e2e suite does) refuses to use an enum
    // value in the transaction that added it.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "customer_withdrawal_requests" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "wallet_id" UUID NOT NULL REFERENCES "customer_wallets"("id") ON DELETE RESTRICT,
        "customer_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "amount" bigint NOT NULL CHECK ("amount" > 0),
        "bank_bin" varchar(8) NOT NULL,
        "bank_name" varchar(128) NOT NULL,
        "bank_account_number" varchar(64) NOT NULL,
        "bank_account_name" varchar(128) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'PROCESSING'
          CHECK ("status" IN ('PROCESSING', 'SUCCESS', 'FAILED')),
        "requested_at" timestamptz NOT NULL DEFAULT now(),
        "transaction_id" UUID NULL REFERENCES "customer_wallet_transactions"("id") ON DELETE SET NULL,
        "payout_id" varchar(64) NULL,
        "payout_state" varchar(32) NULL,
        "payout_bank_reference" varchar(128) NULL,
        "payout_attempted_at" timestamptz NULL,
        "failure_reason" text NULL,
        "refund_transaction_id" UUID NULL REFERENCES "customer_wallet_transactions"("id") ON DELETE SET NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_customer_withdrawal_customer" ON "customer_withdrawal_requests" ("customer_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_customer_withdrawal_status" ON "customer_withdrawal_requests" ("status")`);
    // One withdrawal in flight per wallet, as for technicians.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_withdrawal_open_per_wallet"
        ON "customer_withdrawal_requests" ("wallet_id")
        WHERE "status" NOT IN ('SUCCESS', 'REJECTED', 'FAILED')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_withdrawal_requests"`);
    // The ledger is never rewritten to roll back: withdrawal rows already
    // recorded stay (NOT VALID skips existing rows) and new ones are refused.
    await queryRunner.query(`ALTER TABLE "customer_wallet_transactions" DROP CONSTRAINT IF EXISTS "customer_wallet_transactions_type_check"`);
    await queryRunner.query(`
      ALTER TABLE "customer_wallet_transactions" ADD CONSTRAINT "customer_wallet_transactions_type_check"
        CHECK ("type" IN ('top_up', 'invoice_payment', 'refund', 'adjustment_credit', 'adjustment_debit')) NOT VALID
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_bank_accounts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_verification_documents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_verifications"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "full_address"`);
  }
}
