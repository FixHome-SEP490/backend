// src/database/migrations/1790000000005-PartRequestsAndLifecycle.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class PartRequestsAndLifecycle1790000000005 implements MigrationInterface {
  name = 'PartRequestsAndLifecycle1790000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add EXTERNAL to part_source_enum if not already present
    await queryRunner.query(`
      ALTER TYPE "part_source_enum" ADD VALUE IF NOT EXISTS 'external';
    `);

    // 2. Create new enums safely
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "part_request_status_enum" AS ENUM ('requested', 'ready', 'delivering', 'received', 'completed', 'cancelled');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "part_request_type_enum" AS ENUM ('pre_repair', 'additional');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "fulfillment_method_enum" AS ENUM ('pickup', 'delivery');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "part_usage_status_enum" AS ENUM ('pending', 'used', 'returned');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // 3. Create part_requests table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "part_requests" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "service_order_id" UUID NOT NULL,
        "technician_id" UUID NOT NULL,
        "request_type" "part_request_type_enum" NOT NULL,
        "fulfillment_method" "fulfillment_method_enum" NOT NULL DEFAULT 'pickup',
        "status" "part_request_status_enum" NOT NULL DEFAULT 'requested',
        "reason" TEXT,
        "shipping_fee" BIGINT NOT NULL DEFAULT 0,
        "additional_cost_id" UUID,
        "qr_token" VARCHAR(128),
        "qr_generated_at" TIMESTAMPTZ,
        "received_at" TIMESTAMPTZ,
        "completed_at" TIMESTAMPTZ,
        "cancelled_at" TIMESTAMPTZ,
        "prepared_by_user_id" UUID,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_part_requests_service_order" ON "part_requests" ("service_order_id");
      CREATE INDEX IF NOT EXISTS "ix_part_requests_technician" ON "part_requests" ("technician_id");
      CREATE INDEX IF NOT EXISTS "ix_part_requests_status" ON "part_requests" ("status");
    `);

    // 4. Create part_request_items table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "part_request_items" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "part_request_id" UUID NOT NULL REFERENCES "part_requests"("id") ON DELETE CASCADE,
        "part_catalog_id" UUID,
        "part_source" "part_source_enum" NOT NULL DEFAULT 'fixhome',
        "part_name_snapshot" VARCHAR(255) NOT NULL,
        "quantity" INT NOT NULL DEFAULT 1,
        "unit_price_snapshot" BIGINT NOT NULL DEFAULT 0,
        "usage_status" "part_usage_status_enum" NOT NULL DEFAULT 'pending',
        "note" TEXT,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_part_request_items_request" ON "part_request_items" ("part_request_id");
    `);

    // 5. Add fulfillment_method and shipping_fee to additional_cost_requests
    await queryRunner.query(`
      ALTER TABLE "additional_cost_requests"
      ADD COLUMN IF NOT EXISTS "fulfillment_method" "fulfillment_method_enum",
      ADD COLUMN IF NOT EXISTS "shipping_fee" BIGINT NOT NULL DEFAULT 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "additional_cost_requests"
      DROP COLUMN IF EXISTS "shipping_fee",
      DROP COLUMN IF EXISTS "fulfillment_method";
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "part_request_items";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "part_requests";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "part_usage_status_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "fulfillment_method_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "part_request_type_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "part_request_status_enum";`);
  }
}
