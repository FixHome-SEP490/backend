import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 10/10/2026: a technician sets a default labor warranty. The profile keeps it (used when a
 * service has no warranty of its own), and an order keeps the labor warranty fixed when its
 * technician is assigned, so a fixed-price job no longer ends with a 0-day labor warranty.
 */
export class TechnicianDefaultWarranty1790000000033 implements MigrationInterface {
  name = 'TechnicianDefaultWarranty1790000000033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "technician_profiles" ADD COLUMN IF NOT EXISTS "default_labor_warranty_days" int NULL CHECK ("default_labor_warranty_days" >= 0)`);
    await queryRunner.query(`ALTER TABLE "service_orders" ADD COLUMN IF NOT EXISTS "labor_warranty_days" int NULL CHECK ("labor_warranty_days" >= 0)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "service_orders" DROP COLUMN IF EXISTS "labor_warranty_days"`);
    await queryRunner.query(`ALTER TABLE "technician_profiles" DROP COLUMN IF EXISTS "default_labor_warranty_days"`);
  }
}
