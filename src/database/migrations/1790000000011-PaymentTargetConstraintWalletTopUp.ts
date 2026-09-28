import { MigrationInterface, QueryRunner } from 'typeorm';

export class PaymentTargetConstraintWalletTopUp1790000000011 implements MigrationInterface {
  name = 'PaymentTargetConstraintWalletTopUp1790000000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "chk_payments_one_target";
      ALTER TABLE "payments" ADD CONSTRAINT "chk_payments_one_target" CHECK (
        ("purpose"::text = 'wallet_top_up' AND "invoice_id" IS NULL AND "commission_due_id" IS NULL)
        OR
        ("purpose"::text <> 'wallet_top_up' AND (
          (CASE WHEN "invoice_id" IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN "commission_due_id" IS NOT NULL THEN 1 ELSE 0 END) = 1
        ))
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "chk_payments_one_target";
      ALTER TABLE "payments" ADD CONSTRAINT "chk_payments_one_target" CHECK (
        (CASE WHEN "invoice_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "commission_due_id" IS NOT NULL THEN 1 ELSE 0 END) = 1
      );
    `);
  }
}
