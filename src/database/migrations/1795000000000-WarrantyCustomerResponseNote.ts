import { MigrationInterface, QueryRunner } from 'typeorm';

/** Why the customer disputed a warranty result, kept on the claim itself (the dispute no longer opens a support case). Forward-only, nullable. */
export class WarrantyCustomerResponseNote1795000000000 implements MigrationInterface {
  name = 'WarrantyCustomerResponseNote1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS customer_response_note text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE warranty_claims DROP COLUMN IF EXISTS customer_response_note`);
  }
}
