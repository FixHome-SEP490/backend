import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A technician with no review used to carry average_rating 5.00 by default, so
 * clients showed "5.0 ★" and matching ranked them above technicians with real
 * reviews. With no review the stored average is 0 and the API returns no
 * rating; clients show "Chưa có đánh giá" (PO 07/10/2026: no fake data).
 */
export class HonestTechnicianRatings1790000000027 implements MigrationInterface {
  name = 'HonestTechnicianRatings1790000000027';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "technician_profiles" ALTER COLUMN "average_rating" SET DEFAULT 0`);
    await queryRunner.query(`UPDATE "technician_profiles" SET "average_rating" = 0 WHERE "rating_count" = 0`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "technician_profiles" SET "average_rating" = 5 WHERE "rating_count" = 0`);
    await queryRunner.query(`ALTER TABLE "technician_profiles" ALTER COLUMN "average_rating" SET DEFAULT 5`);
  }
}
