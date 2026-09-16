// src/database/migrations/1725896000000-SpecV14GapFixes.ts
// Sprint D1-A: Fix critical gaps for Spec v1.4 compliance
import { MigrationInterface, QueryRunner } from 'typeorm';

export class SpecV14GapFixes1725896000000 implements MigrationInterface {
  name = 'SpecV14GapFixes1725896000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── A1: Part Source + Warranty enums ──
    await queryRunner.query(`
      CREATE TYPE "part_source_enum" AS ENUM ('fixhome', 'technician')
    `);
    await queryRunner.query(`
      CREATE TYPE "part_warranty_option_enum" AS ENUM ('no_warranty', 'included', 'paid_warranty')
    `);

    // ── A1: QuotationItem — add part source fields ──
    await queryRunner.query(`
      ALTER TABLE "quotation_items"
      ADD COLUMN "part_source" "part_source_enum",
      ADD COLUMN "part_catalog_id" uuid,
      ADD COLUMN "part_name_snapshot" varchar,
      ADD COLUMN "part_warranty_option" "part_warranty_option_enum",
      ADD COLUMN "warranty_fee" bigint,
      ADD COLUMN "warranty_term_days" int
    `);

    // ── A1: AdditionalCostItem — add part source fields ──
    await queryRunner.query(`
      ALTER TABLE "additional_cost_items"
      ADD COLUMN "part_source" "part_source_enum",
      ADD COLUMN "part_catalog_id" uuid,
      ADD COLUMN "part_name_snapshot" varchar,
      ADD COLUMN "part_warranty_option" "part_warranty_option_enum",
      ADD COLUMN "warranty_fee" bigint,
      ADD COLUMN "warranty_term_days" int
    `);

    // ── A1: InvoiceItem — add part source/warranty fields ──
    await queryRunner.query(`
      ALTER TABLE "invoice_items"
      ADD COLUMN "part_source" "part_source_enum",
      ADD COLUMN "part_warranty_option" "part_warranty_option_enum",
      ADD COLUMN "warranty_fee" bigint
    `);

    // ── A2: Booking — add address snapshots + time window ──
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN "address_text_snapshot" text,
      ADD COLUMN "latitude_snapshot" decimal(10,7),
      ADD COLUMN "longitude_snapshot" decimal(10,7),
      ADD COLUMN "preferred_start_at" timestamptz,
      ADD COLUMN "preferred_end_at" timestamptz
    `);

    // Migrate existing preferred_at data to preferred_start_at
    await queryRunner.query(`
      UPDATE "bookings"
      SET "preferred_start_at" = "preferred_at"
      WHERE "preferred_at" IS NOT NULL
    `);

    // Drop old columns (safe — data migrated above)
    await queryRunner.query(`
      ALTER TABLE "bookings"
      DROP COLUMN IF EXISTS "preferred_at",
      DROP COLUMN IF EXISTS "preferred_time_window"
    `);

    // ── A3: BookingStatus enum — add SUBMITTED, CLOSED; remove PENDING ──
    await queryRunner.query(`
      CREATE TYPE booking_status_v14_enum AS ENUM ('pending', 'submitted', 'matching', 'matched', 'cancelled', 'closed');
      ALTER TABLE bookings ALTER COLUMN status DROP DEFAULT;
      ALTER TABLE bookings ALTER COLUMN status TYPE booking_status_v14_enum USING status::text::booking_status_v14_enum;
      ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'submitted';
    `);

    // Migrate existing PENDING bookings to SUBMITTED
    await queryRunner.query(`
      UPDATE "bookings" SET "status" = 'submitted' WHERE "status" = 'pending'
    `);

    // ── A7: Invoice — add commission rate snapshot + parts breakdown ──
    await queryRunner.query(`
      ALTER TABLE "invoices"
      ADD COLUMN "commission_rate_snapshot" decimal(5,4) DEFAULT 0.1,
      ADD COLUMN "fixhome_parts_total" bigint DEFAULT 0,
      ADD COLUMN "technician_parts_total" bigint DEFAULT 0,
      ADD COLUMN "technician_part_warranty_fee_total" bigint DEFAULT 0
    `);

    // ── A8: Quotation — add version ──
    await queryRunner.query(`
      ALTER TABLE "quotations"
      ADD COLUMN "version" int DEFAULT 1
    `);

    // ── B1: ServiceOrder — completion request fields ──
    await queryRunner.query(`
      ALTER TABLE "service_orders"
      ADD COLUMN "completion_requested_at" timestamptz,
      ADD COLUMN "completion_note" text
    `);

    // ── B1: CustomerServiceConfirmation table ──
    await queryRunner.query(`
      CREATE TABLE "customer_service_confirmations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "service_order_id" uuid NOT NULL REFERENCES "service_orders"("id") ON DELETE CASCADE,
        "customer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "confirmed_at" timestamptz NOT NULL DEFAULT now(),
        "feedback" text,
        "rating" int,
        "signature_url" varchar,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_confirmation_order" UNIQUE ("service_order_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_confirmation_customer" ON "customer_service_confirmations" ("customer_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ── Revert B1 ──
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_service_confirmations"`);
    await queryRunner.query(`
      ALTER TABLE "service_orders"
      DROP COLUMN IF EXISTS "completion_requested_at",
      DROP COLUMN IF EXISTS "completion_note"
    `);

    // ── Revert A8 ──
    await queryRunner.query(`ALTER TABLE "quotations" DROP COLUMN IF EXISTS "version"`);

    // ── Revert A7 ──
    await queryRunner.query(`
      ALTER TABLE "invoices"
      DROP COLUMN IF EXISTS "commission_rate_snapshot",
      DROP COLUMN IF EXISTS "fixhome_parts_total",
      DROP COLUMN IF EXISTS "technician_parts_total",
      DROP COLUMN IF EXISTS "technician_part_warranty_fee_total"
    `);

    // ── Revert A3 (cannot remove enum values in PG, just update data) ──
    await queryRunner.query(`
      UPDATE "bookings" SET "status" = 'pending' WHERE "status" = 'submitted'
    `);

    // ── Revert A2 ──
    await queryRunner.query(`
      UPDATE bookings SET status = 'pending' WHERE status = 'closed';
      ALTER TABLE bookings ALTER COLUMN status DROP DEFAULT;
      ALTER TABLE bookings ALTER COLUMN status TYPE booking_status_enum USING status::text::booking_status_enum;
      ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'pending';
      DROP TYPE booking_status_v14_enum;
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN "preferred_at" timestamptz,
      ADD COLUMN "preferred_time_window" varchar(100)
    `);
    await queryRunner.query(`
      UPDATE "bookings"
      SET "preferred_at" = "preferred_start_at"
      WHERE "preferred_start_at" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      DROP COLUMN IF EXISTS "address_text_snapshot",
      DROP COLUMN IF EXISTS "latitude_snapshot",
      DROP COLUMN IF EXISTS "longitude_snapshot",
      DROP COLUMN IF EXISTS "preferred_start_at",
      DROP COLUMN IF EXISTS "preferred_end_at"
    `);

    // ── Revert A1: InvoiceItem ──
    await queryRunner.query(`
      ALTER TABLE "invoice_items"
      DROP COLUMN IF EXISTS "part_source",
      DROP COLUMN IF EXISTS "part_warranty_option",
      DROP COLUMN IF EXISTS "warranty_fee"
    `);

    // ── Revert A1: AdditionalCostItem ──
    await queryRunner.query(`
      ALTER TABLE "additional_cost_items"
      DROP COLUMN IF EXISTS "part_source",
      DROP COLUMN IF EXISTS "part_catalog_id",
      DROP COLUMN IF EXISTS "part_name_snapshot",
      DROP COLUMN IF EXISTS "part_warranty_option",
      DROP COLUMN IF EXISTS "warranty_fee",
      DROP COLUMN IF EXISTS "warranty_term_days"
    `);

    // ── Revert A1: QuotationItem ──
    await queryRunner.query(`
      ALTER TABLE "quotation_items"
      DROP COLUMN IF EXISTS "part_source",
      DROP COLUMN IF EXISTS "part_catalog_id",
      DROP COLUMN IF EXISTS "part_name_snapshot",
      DROP COLUMN IF EXISTS "part_warranty_option",
      DROP COLUMN IF EXISTS "warranty_fee",
      DROP COLUMN IF EXISTS "warranty_term_days"
    `);

    // ── Revert enums ──
    await queryRunner.query(`DROP TYPE IF EXISTS "part_warranty_option_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "part_source_enum"`);
  }
}
