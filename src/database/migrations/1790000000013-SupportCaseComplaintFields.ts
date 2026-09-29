import { MigrationInterface, QueryRunner } from 'typeorm';

export class SupportCaseComplaintFields1790000000013 implements MigrationInterface {
  name = 'SupportCaseComplaintFields1790000000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "support_case_type_enum" ADD VALUE IF NOT EXISTS 'property_damage';
      ALTER TYPE "support_case_type_enum" ADD VALUE IF NOT EXISTS 'quality';
      ALTER TYPE "support_case_type_enum" ADD VALUE IF NOT EXISTS 'pricing_dispute';
      ALTER TYPE "support_case_type_enum" ADD VALUE IF NOT EXISTS 'conduct';

      ALTER TABLE "support_cases"
      ADD COLUMN IF NOT EXISTS "is_urgent" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "respond_by" timestamptz;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Enum values cannot be dropped from a PostgreSQL enum without recreating the type.
    await queryRunner.query(`
      ALTER TABLE "support_cases"
      DROP COLUMN IF EXISTS "respond_by",
      DROP COLUMN IF EXISTS "is_urgent";
    `);
  }
}
