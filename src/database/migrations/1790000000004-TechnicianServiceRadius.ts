import { MigrationInterface, QueryRunner } from 'typeorm';

export class TechnicianServiceRadius1790000000004 implements MigrationInterface {
  name = 'TechnicianServiceRadius1790000000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "technician_profiles"
      ADD COLUMN "service_radius_km" decimal(5,1) NOT NULL DEFAULT 10
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "technician_profiles"
      DROP COLUMN "service_radius_km"
    `);
  }
}
