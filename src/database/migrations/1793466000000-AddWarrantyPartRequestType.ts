import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A warranty re-service may need a part from FixHome (PO 04/11/2026). The new
 * enum value is used only by the next migration, after this one has committed.
 */
export class AddWarrantyPartRequestType1793466000000 implements MigrationInterface {
  name = 'AddWarrantyPartRequestType1793466000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE part_request_type_enum ADD VALUE IF NOT EXISTS 'warranty'`);
  }

  public async down(): Promise<void> {
    // PostgreSQL cannot remove an enum label; the CHECK in the next migration governs its use.
  }
}
