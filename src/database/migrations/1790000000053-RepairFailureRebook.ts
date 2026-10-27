import { MigrationInterface, QueryRunner } from 'typeorm';

export class RepairFailureRebook1790000000053 implements MigrationInterface {
  name = 'RepairFailureRebook1790000000053';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "repair_failure_rebooks" (
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
      CONSTRAINT "chk_repair_failure_rebooks_scope" CHECK ("scope_kind" IN ('booking','visit_group')),
      CONSTRAINT "chk_repair_failure_rebooks_count" CHECK (("source_count" = 1 AND "target_visit_group_id" IS NULL) OR ("source_count" IN (2,3) AND "target_visit_group_id" IS NOT NULL))
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_repair_failure_rebooks_scope_key" ON "repair_failure_rebooks" ("customer_id","scope_kind","scope_id","idempotency_key")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_repair_failure_rebooks_group" ON "repair_failure_rebooks" ("target_visit_group_id") WHERE "target_visit_group_id" IS NOT NULL`);
    await queryRunner.query(`CREATE TABLE "repair_failure_rebook_sources" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "rebook_id" uuid NOT NULL REFERENCES "repair_failure_rebooks"("id"),
      "source_booking_id" uuid NOT NULL REFERENCES "bookings"("id"),
      "source_incident_id" uuid NOT NULL REFERENCES "support_cases"("id"),
      "target_booking_id" uuid NOT NULL REFERENCES "bookings"("id"),
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_repair_failure_rebook_source" ON "repair_failure_rebook_sources" ("source_booking_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_repair_failure_rebook_incident" ON "repair_failure_rebook_sources" ("source_incident_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_repair_failure_rebook_target" ON "repair_failure_rebook_sources" ("target_booking_id")`);
    await queryRunner.query(`CREATE INDEX "ix_repair_failure_rebook_sources_batch" ON "repair_failure_rebook_sources" ("rebook_id")`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(`SELECT EXISTS (SELECT 1 FROM "repair_failure_rebooks") AS "exists"`);
    if (rows[0]?.exists) throw new Error('Refusing to delete durable repair-failure rebook receipts');
    await queryRunner.query(`DROP TABLE "repair_failure_rebook_sources"`);
    await queryRunner.query(`DROP TABLE "repair_failure_rebooks"`);
  }
}
