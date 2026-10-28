import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive workflow identity; no historical case, invoice or ledger is rewritten. */
export class InterruptionWorkflow1793203200000 implements MigrationInterface {
  name = 'InterruptionWorkflow1793203200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "support_cases" ADD COLUMN "request_intent" varchar(32)`);
    await queryRunner.query(`ALTER TABLE "support_cases" ADD COLUMN "workflow_version" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "support_cases" ADD COLUMN "interruption_command_id" uuid`);
    await queryRunner.query(`ALTER TABLE "support_cases" ADD COLUMN "interruption_fingerprint" char(64)`);
    await queryRunner.query(`ALTER TABLE "support_cases" ADD CONSTRAINT "chk_support_request_intent" CHECK ("request_intent" IS NULL OR "request_intent" = 'stop_or_replace')`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_support_active_stop_request" ON "support_cases" ("service_order_id") WHERE "request_intent" = 'stop_or_replace' AND "status" IN ('open', 'in_review')`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_support_interruption_command" ON "support_cases" ("interruption_command_id") WHERE "interruption_command_id" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "visit_group_items" DROP CONSTRAINT "chk_visit_group_items_outcome"`);
    await queryRunner.query(`ALTER TABLE "visit_group_items" ADD CONSTRAINT "chk_visit_group_items_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('succeeded', 'failed', 'quote_declined', 'interrupted'))`);
    await queryRunner.query(`CREATE TABLE "interruption_rebooks" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "customer_id" uuid NOT NULL REFERENCES "users"("id"),
      "scope_kind" varchar(16) NOT NULL,
      "scope_id" uuid NOT NULL,
      "idempotency_key" varchar(128) NOT NULL,
      "request_fingerprint" char(64) NOT NULL,
      "source_count" smallint NOT NULL,
      "target_visit_group_id" uuid REFERENCES "visit_groups"("id"),
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "chk_interruption_rebooks_scope" CHECK ("scope_kind" IN ('booking','visit_group')),
      CONSTRAINT "chk_interruption_rebooks_count" CHECK (("source_count" = 1 AND "target_visit_group_id" IS NULL) OR ("source_count" IN (2,3) AND "target_visit_group_id" IS NOT NULL))
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_interruption_rebooks_scope_key" ON "interruption_rebooks" ("customer_id","scope_kind","scope_id","idempotency_key")`);
    await queryRunner.query(`CREATE TABLE "interruption_rebook_sources" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "rebook_id" uuid NOT NULL REFERENCES "interruption_rebooks"("id"),
      "source_booking_id" uuid NOT NULL REFERENCES "bookings"("id"),
      "source_case_id" uuid NOT NULL REFERENCES "support_cases"("id"),
      "target_booking_id" uuid NOT NULL REFERENCES "bookings"("id"),
      "previous_technician_id" uuid NOT NULL REFERENCES "users"("id"),
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_interruption_rebook_source" ON "interruption_rebook_sources" ("source_booking_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_interruption_rebook_case" ON "interruption_rebook_sources" ("source_case_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_interruption_rebook_target" ON "interruption_rebook_sources" ("target_booking_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ count: string }> = await queryRunner.query(`SELECT count(*)::text AS count FROM "support_cases" WHERE "request_intent" IS NOT NULL OR "interruption_command_id" IS NOT NULL`);
    if (Number(rows[0]?.count) > 0) throw new Error('Refusing to discard interruption workflow receipts');
    const interrupted: Array<{ count: string }> = await queryRunner.query(`SELECT count(*)::text AS count FROM "visit_group_items" WHERE "outcome" = 'interrupted'`);
    if (Number(interrupted[0]?.count) > 0) throw new Error('Refusing to discard interrupted visit outcomes');
    const rebooks: Array<{ count: string }> = await queryRunner.query(`SELECT count(*)::text AS count FROM "interruption_rebooks"`);
    if (Number(rebooks[0]?.count) > 0) throw new Error('Refusing to discard interruption rebook receipts');
    await queryRunner.query(`DROP TABLE "interruption_rebook_sources"`);
    await queryRunner.query(`DROP TABLE "interruption_rebooks"`);
    await queryRunner.query(`ALTER TABLE "visit_group_items" DROP CONSTRAINT "chk_visit_group_items_outcome"`);
    await queryRunner.query(`ALTER TABLE "visit_group_items" ADD CONSTRAINT "chk_visit_group_items_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('succeeded', 'failed', 'quote_declined'))`);
    await queryRunner.query(`DROP INDEX "uq_support_interruption_command"`);
    await queryRunner.query(`DROP INDEX "uq_support_active_stop_request"`);
    await queryRunner.query(`ALTER TABLE "support_cases" DROP CONSTRAINT "chk_support_request_intent"`);
    await queryRunner.query(`ALTER TABLE "support_cases" DROP COLUMN "interruption_fingerprint"`);
    await queryRunner.query(`ALTER TABLE "support_cases" DROP COLUMN "interruption_command_id"`);
    await queryRunner.query(`ALTER TABLE "support_cases" DROP COLUMN "workflow_version"`);
    await queryRunner.query(`ALTER TABLE "support_cases" DROP COLUMN "request_intent"`);
  }
}
