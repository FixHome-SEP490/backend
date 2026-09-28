import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWalletTopUpToPaymentPurposeEnum1790000000010 implements MigrationInterface {
  name = 'AddWalletTopUpToPaymentPurposeEnum1790000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "payment_purpose_enum" ADD VALUE IF NOT EXISTS 'wallet_top_up';
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // In PostgreSQL, values cannot be dropped from an enum type without recreating it
  }
}
