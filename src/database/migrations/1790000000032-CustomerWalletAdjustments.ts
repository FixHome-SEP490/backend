import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 09/10/2026: the admin can see every customer's wallet and correct its
 * balance with a reason, as already done for technician wallets. Two new
 * transaction types keep the amount positive and say the direction.
 */
export class CustomerWalletAdjustments1790000000032 implements MigrationInterface {
  name = 'CustomerWalletAdjustments1790000000032';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customer_wallet_transactions" DROP CONSTRAINT IF EXISTS "customer_wallet_transactions_type_check"`);
    await queryRunner.query(`
      ALTER TABLE "customer_wallet_transactions" ADD CONSTRAINT "customer_wallet_transactions_type_check"
        CHECK ("type" IN ('top_up', 'invoice_payment', 'refund', 'adjustment_credit', 'adjustment_debit'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The ledger is never rewritten to roll back: adjustments already recorded stay
    // (NOT VALID skips existing rows) and new ones are refused again.
    await queryRunner.query(`ALTER TABLE "customer_wallet_transactions" DROP CONSTRAINT IF EXISTS "customer_wallet_transactions_type_check"`);
    await queryRunner.query(`
      ALTER TABLE "customer_wallet_transactions" ADD CONSTRAINT "customer_wallet_transactions_type_check"
        CHECK ("type" IN ('top_up', 'invoice_payment', 'refund')) NOT VALID
    `);
  }
}
