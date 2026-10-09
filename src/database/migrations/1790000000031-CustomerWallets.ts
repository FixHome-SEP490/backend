import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer wallet (PO 08/10/2026): a customer tops up through VNPay, pays
 * invoices from the balance and receives refunds into it. There is no
 * withdrawal (customers have no KYC). Kept apart from the technician wallets,
 * whose settlement, commission and payout logic must never see these rows.
 * Transactions are append-only: a balance change is a new row.
 */
export class CustomerWallets1790000000031 implements MigrationInterface {
  name = 'CustomerWallets1790000000031';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "customer_wallets" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "user_id" UUID NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE RESTRICT,
        "balance" bigint NOT NULL DEFAULT 0 CHECK ("balance" >= 0),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "customer_wallet_transactions" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "wallet_id" UUID NOT NULL REFERENCES "customer_wallets"("id") ON DELETE RESTRICT,
        "type" varchar(20) NOT NULL CHECK ("type" IN ('top_up', 'invoice_payment', 'refund')),
        "amount" bigint NOT NULL CHECK ("amount" > 0),
        "balance_before" bigint NOT NULL,
        "balance_after" bigint NOT NULL CHECK ("balance_after" >= 0),
        "reference_type" varchar(32) NULL,
        "reference_id" varchar(128) NULL,
        "idempotency_key" varchar(160) NOT NULL UNIQUE,
        "description" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_customer_wallet_tx_wallet_created" ON "customer_wallet_transactions" ("wallet_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_customer_wallet_tx_reference" ON "customer_wallet_transactions" ("reference_type", "reference_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_wallet_transactions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_wallets"`);
  }
}
