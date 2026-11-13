import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BUG DETECTOR 62 (PO 13/11/2026): the admin sets, per campaign, how many times one customer
 * may use a general voucher (1 = once, as before). The per-customer unique index becomes a
 * service rule under the campaign row lock, because a refund puts a used claim back to unused
 * and a partial unique index would then make the refund fail. Existing campaigns keep 1.
 * Column on the existing voucher_campaigns table only; no new table.
 */
export class VoucherPerCustomerLimit1794566400000 implements MigrationInterface {
  name = 'VoucherPerCustomerLimit1794566400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "voucher_campaigns" ADD COLUMN IF NOT EXISTS "per_customer_limit" integer NOT NULL DEFAULT 1`);
    await queryRunner.query(`ALTER TABLE "voucher_campaigns" ADD CONSTRAINT "ck_voucher_per_customer_limit"
      CHECK ("per_customer_limit" BETWEEN 1 AND 100)`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_voucher_claim_customer"`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_voucher_claim_customer" ON "voucher_claims" ("campaign_id", "customer_id") WHERE "source_key" IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_voucher_claim_customer"`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_voucher_claim_customer" ON "voucher_claims" ("campaign_id", "customer_id") WHERE "source_key" IS NULL`);
    await queryRunner.query(`ALTER TABLE "voucher_campaigns" DROP CONSTRAINT IF EXISTS "ck_voucher_per_customer_limit"`);
    await queryRunner.query(`ALTER TABLE "voucher_campaigns" DROP COLUMN IF EXISTS "per_customer_limit"`);
  }
}
