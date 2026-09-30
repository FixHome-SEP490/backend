import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enum values for automatic withdrawal payouts, on their own.
 *
 * PostgreSQL will not let a new enum value be used in the transaction that
 * added it, and WithdrawalPayout1790000000021 builds an index on PROCESSING.
 * Migrations run one transaction each here, so adding the values in a separate
 * migration commits them before the next one needs them.
 *
 * Numbered 0020 rather than 0013: 0013 to 0016 are already taken on the shared
 * database by migrations not yet pushed to any branch.
 */
export class WithdrawalPayoutEnums1790000000020 implements MigrationInterface {
  name = 'WithdrawalPayoutEnums1790000000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "withdrawal_status_enum" ADD VALUE IF NOT EXISTS 'PROCESSING';
    `);
    await queryRunner.query(`
      ALTER TYPE "wallet_transaction_type_enum" ADD VALUE IF NOT EXISTS 'WITHDRAW_REFUND';
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Enum values cannot be dropped without recreating the type. Left unused,
    // they are harmless.
  }
}
