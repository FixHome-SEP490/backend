import { MigrationInterface, QueryRunner } from 'typeorm';

/** Expand VisitGroup sequence and group rebook counts after approval of 1–5 devices per visit. */
export class VisitGroupDeviceLimitFive1793379600001 implements MigrationInterface {
  name = 'VisitGroupDeviceLimitFive1793379600001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "visit_group_items"
        DROP CONSTRAINT IF EXISTS "chk_visit_group_items_sequence"
    `);
    await queryRunner.query(`
      ALTER TABLE "visit_group_items"
        ADD CONSTRAINT "chk_visit_group_items_sequence" CHECK ("sequence" BETWEEN 1 AND 5)
    `);
    await queryRunner.query(`
      ALTER TABLE "repair_failure_rebooks"
        DROP CONSTRAINT IF EXISTS "chk_repair_failure_rebooks_count"
    `);
    await queryRunner.query(`
      ALTER TABLE "repair_failure_rebooks"
        ADD CONSTRAINT "chk_repair_failure_rebooks_count"
        CHECK (("source_count" = 1 AND "target_visit_group_id" IS NULL)
          OR ("source_count" IN (2,3,4,5) AND "target_visit_group_id" IS NOT NULL))
    `);
    await queryRunner.query(`
      ALTER TABLE "interruption_rebooks"
        DROP CONSTRAINT IF EXISTS "chk_interruption_rebooks_count"
    `);
    await queryRunner.query(`
      ALTER TABLE "interruption_rebooks"
        ADD CONSTRAINT "chk_interruption_rebooks_count"
        CHECK (("source_count" = 1 AND "target_visit_group_id" IS NULL)
          OR ("source_count" IN (2,3,4,5) AND "target_visit_group_id" IS NOT NULL))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = await queryRunner.query(`
      SELECT 1 WHERE
        EXISTS (SELECT 1 FROM "visit_group_items" WHERE "sequence" > 3)
        OR EXISTS (SELECT 1 FROM "repair_failure_rebooks"
          WHERE "target_visit_group_id" IS NOT NULL AND "source_count" > 3)
        OR EXISTS (SELECT 1 FROM "interruption_rebooks"
          WHERE "target_visit_group_id" IS NOT NULL AND "source_count" > 3)
    `);
    if (rows.length) {
      throw new Error('Refusing to restore the three-device VisitGroup and rebook limits while 4/5-device rows exist.');
    }

    await queryRunner.query(`
      ALTER TABLE "visit_group_items"
        DROP CONSTRAINT IF EXISTS "chk_visit_group_items_sequence"
    `);
    await queryRunner.query(`
      ALTER TABLE "visit_group_items"
        ADD CONSTRAINT "chk_visit_group_items_sequence" CHECK ("sequence" BETWEEN 1 AND 3)
    `);
    await queryRunner.query(`
      ALTER TABLE "repair_failure_rebooks"
        DROP CONSTRAINT IF EXISTS "chk_repair_failure_rebooks_count"
    `);
    await queryRunner.query(`
      ALTER TABLE "repair_failure_rebooks"
        ADD CONSTRAINT "chk_repair_failure_rebooks_count"
        CHECK (("source_count" = 1 AND "target_visit_group_id" IS NULL)
          OR ("source_count" IN (2,3) AND "target_visit_group_id" IS NOT NULL))
    `);
    await queryRunner.query(`
      ALTER TABLE "interruption_rebooks"
        DROP CONSTRAINT IF EXISTS "chk_interruption_rebooks_count"
    `);
    await queryRunner.query(`
      ALTER TABLE "interruption_rebooks"
        ADD CONSTRAINT "chk_interruption_rebooks_count"
        CHECK (("source_count" = 1 AND "target_visit_group_id" IS NULL)
          OR ("source_count" IN (2,3) AND "target_visit_group_id" IS NOT NULL))
    `);
  }
}
