import { MigrationInterface, QueryRunner } from 'typeorm';

export class TechnicianOnboardingFields1790000000012 implements MigrationInterface {
  name = 'TechnicianOnboardingFields1790000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "date_of_birth" date,
      ADD COLUMN IF NOT EXISTS "gender" varchar(10),
      ADD COLUMN IF NOT EXISTS "citizen_id_number" varchar(20);

      ALTER TABLE "technician_profiles"
      ADD COLUMN IF NOT EXISTS "onboarding_status" varchar(20) NOT NULL DEFAULT 'not_started',
      ADD COLUMN IF NOT EXISTS "onboarding_step" int NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS "full_address" text,
      ADD COLUMN IF NOT EXISTS "latitude" decimal(10,7),
      ADD COLUMN IF NOT EXISTS "longitude" decimal(10,7);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "technician_profiles"
      DROP COLUMN IF EXISTS "longitude",
      DROP COLUMN IF EXISTS "latitude",
      DROP COLUMN IF EXISTS "full_address",
      DROP COLUMN IF EXISTS "onboarding_step",
      DROP COLUMN IF EXISTS "onboarding_status";

      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "citizen_id_number",
      DROP COLUMN IF EXISTS "gender",
      DROP COLUMN IF EXISTS "date_of_birth";
    `);
  }
}
