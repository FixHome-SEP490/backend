import { MigrationInterface, QueryRunner } from 'typeorm';

/** How many of each faulty part line are actually faulty (a line can be x3 with one bad). Forward-only, nullable: null = the whole line. */
export class WarrantyFaultyQuantities1793466000020 implements MigrationInterface {
  name = 'WarrantyFaultyQuantities1793466000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE warranty_visits ADD COLUMN faulty_quantities jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE warranty_visits DROP COLUMN faulty_quantities`);
  }
}
