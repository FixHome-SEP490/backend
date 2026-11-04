import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive only. Apply through the Lead's migration gate, never synchronize. */
export class BookingDrafts1793379600002 implements MigrationInterface {
  name = 'BookingDrafts1793379600002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "booking_drafts" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "customer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
      "version" integer NOT NULL DEFAULT 1,
      "snapshot" jsonb NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      "expires_at" timestamptz NOT NULL,
      CONSTRAINT "uq_booking_drafts_customer" UNIQUE ("customer_id"),
      CONSTRAINT "ck_booking_drafts_version" CHECK ("version" >= 1),
      CONSTRAINT "ck_booking_drafts_snapshot" CHECK (jsonb_typeof("snapshot") = 'object' AND octet_length("snapshot"::text) <= 65536),
      CONSTRAINT "ck_booking_drafts_expiry" CHECK ("expires_at" > "created_at")
    )`);
    await queryRunner.query(`CREATE INDEX "ix_booking_drafts_expiry" ON "booking_drafts" ("expires_at")`);
    await queryRunner.query(`CREATE TABLE "booking_draft_submit_receipts" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "customer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
      "draft_id" uuid NOT NULL,
      "operation_key" uuid NOT NULL,
      "request_fingerprint" char(64) NOT NULL,
      "kind" varchar(16) NOT NULL,
      "booking_id" uuid REFERENCES "bookings"("id") ON DELETE RESTRICT,
      "visit_group_id" uuid REFERENCES "visit_groups"("id") ON DELETE RESTRICT,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "retain_until" timestamptz NOT NULL,
      CONSTRAINT "uq_booking_draft_receipt_operation" UNIQUE ("customer_id", "draft_id", "operation_key"),
      CONSTRAINT "uq_booking_draft_receipt_generation" UNIQUE ("customer_id", "draft_id"),
      CONSTRAINT "ck_booking_draft_receipt_fingerprint" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
      CONSTRAINT "ck_booking_draft_receipt_target" CHECK (
        ("kind" = 'booking' AND "booking_id" IS NOT NULL AND "visit_group_id" IS NULL) OR
        ("kind" = 'visit_group' AND "booking_id" IS NULL AND "visit_group_id" IS NOT NULL)),
      CONSTRAINT "ck_booking_draft_receipt_retention" CHECK ("retain_until" >= "created_at" + interval '30 days')
    )`);
    await queryRunner.query(`CREATE FUNCTION "booking_draft_receipt_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Booking draft submit receipts are immutable' USING ERRCODE = '23514'; END;
    $$`);
    await queryRunner.query(`CREATE TRIGGER "booking_draft_receipt_immutable"
      BEFORE UPDATE OR DELETE ON "booking_draft_submit_receipts"
      FOR EACH ROW EXECUTE FUNCTION "booking_draft_receipt_immutable"()`);
    // Server DB owner retains access; no client/anon policy grants direct access to private JSON.
    await queryRunner.query(`ALTER TABLE "booking_drafts" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "booking_draft_submit_receipts" ENABLE ROW LEVEL SECURITY`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`LOCK TABLE "booking_drafts", "booking_draft_submit_receipts" IN ACCESS EXCLUSIVE MODE`);
    const rows = await queryRunner.query(`SELECT EXISTS (SELECT 1 FROM "booking_drafts") OR
      EXISTS (SELECT 1 FROM "booking_draft_submit_receipts") AS "occupied"`);
    if (rows[0]?.occupied !== false) throw new Error('Refusing to delete saved booking drafts or submit receipts');
    await queryRunner.query(`DROP TABLE "booking_draft_submit_receipts"`);
    await queryRunner.query(`DROP FUNCTION "booking_draft_receipt_immutable"()`);
    await queryRunner.query(`DROP TABLE "booking_drafts"`);
  }
}
