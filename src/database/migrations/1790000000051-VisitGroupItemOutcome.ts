import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 21/10/2026: each device of a visit ends on its own result. succeeded is
 * charged; quote_declined (the customer refused its on-site quote) and failed
 * (approved but the technician could not make it work) cost the customer
 * nothing. The visit is paid once, after every device has a result.
 */
export class VisitGroupItemOutcome1790000000051 implements MigrationInterface {
  name = 'VisitGroupItemOutcome1790000000051';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "visit_group_items" ADD COLUMN IF NOT EXISTS "outcome" varchar(16)`);
    await queryRunner.query(`ALTER TABLE "visit_group_items" ADD COLUMN IF NOT EXISTS "outcome_reason" text`);
    await queryRunner.query(`ALTER TABLE "visit_group_items" ADD COLUMN IF NOT EXISTS "outcome_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "visit_group_items" ADD CONSTRAINT "chk_visit_group_items_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('succeeded', 'failed', 'quote_declined'))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "visit_group_items" DROP CONSTRAINT IF EXISTS "chk_visit_group_items_outcome"`);
    await queryRunner.query(`ALTER TABLE "visit_group_items" DROP COLUMN IF EXISTS "outcome_at"`);
    await queryRunner.query(`ALTER TABLE "visit_group_items" DROP COLUMN IF EXISTS "outcome_reason"`);
    await queryRunner.query(`ALTER TABLE "visit_group_items" DROP COLUMN IF EXISTS "outcome"`);
  }
}
