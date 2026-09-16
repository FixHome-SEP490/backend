import { MigrationInterface, QueryRunner } from 'typeorm';

export class CustomerServiceAreaAndCodes1725899000000 implements MigrationInterface {
  name = 'CustomerServiceAreaAndCodes1725899000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add province_code and district_code to addresses
    await queryRunner.query(`
      ALTER TABLE "addresses"
      ADD COLUMN IF NOT EXISTS "province_code" VARCHAR(50),
      ADD COLUMN IF NOT EXISTS "district_code" VARCHAR(50)
    `);

    // 2. Add province_name_snapshot and district_name_snapshot to bookings
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "province_name_snapshot" VARCHAR(100),
      ADD COLUMN IF NOT EXISTS "district_name_snapshot" VARCHAR(100)
    `);

    // 3. Populate existing addresses in HCM with standard codes (79 / 760 for District 1)
    await queryRunner.query(`
      UPDATE "addresses"
      SET "province_code" = '79', "district_code" = '760'
      WHERE ("province" ILIKE '%Hồ Chí Minh%' OR "province" ILIKE '%HCM%')
        AND ("district" ILIKE '%Quận 1%' OR "district" = '1' OR "district" ILIKE '%Bến Nghé%' OR "district" ILIKE '%Bến Thành%')
        AND ("province_code" IS NULL OR "district_code" IS NULL)
    `);

    // Default other HCM addresses to province_code '79' if null
    await queryRunner.query(`
      UPDATE "addresses"
      SET "province_code" = '79'
      WHERE ("province" ILIKE '%Hồ Chí Minh%' OR "province" ILIKE '%HCM%')
        AND "province_code" IS NULL
    `);

    // Default Hanoi addresses to province_code '01' if null
    await queryRunner.query(`
      UPDATE "addresses"
      SET "province_code" = '01'
      WHERE ("province" ILIKE '%Hà Nội%' OR "province" ILIKE '%Ha Noi%')
        AND "province_code" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings"
      DROP COLUMN IF EXISTS "district_name_snapshot",
      DROP COLUMN IF EXISTS "province_name_snapshot"
    `);
    await queryRunner.query(`
      ALTER TABLE "addresses"
      DROP COLUMN IF EXISTS "district_code",
      DROP COLUMN IF EXISTS "province_code"
    `);
  }
}
