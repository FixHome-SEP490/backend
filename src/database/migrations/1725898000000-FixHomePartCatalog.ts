// src/database/migrations/1725898000000-FixHomePartCatalog.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave 2A: lightweight FixHome-owned part catalog (reference data only).
 * No inventory/WMS scope: no stock, warehouse, supplier, purchase order,
 * transaction, or reorder columns. Logical deactivation via is_active only.
 */
export class FixHomePartCatalog1725898000000 implements MigrationInterface {
  name = 'FixHomePartCatalog1725898000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "fixhome_parts" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "sku" VARCHAR(100),
        "name" VARCHAR(200) NOT NULL,
        "description" TEXT,
        "selling_price" NUMERIC(12,2) NOT NULL,
        "warranty_days" INTEGER,
        "warranty_policy" TEXT,
        "is_active" BOOLEAN NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "chk_fixhome_parts_selling_price" CHECK ("selling_price" >= 0),
        CONSTRAINT "chk_fixhome_parts_warranty_days" CHECK ("warranty_days" IS NULL OR ("warranty_days" >= 0 AND "warranty_days" <= 3650))
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_fixhome_parts_sku"
        ON "fixhome_parts" ("sku")
        WHERE "sku" IS NOT NULL;
      CREATE INDEX IF NOT EXISTS "idx_fixhome_parts_is_active"
        ON "fixhome_parts" ("is_active");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "fixhome_parts";`);
  }
}
