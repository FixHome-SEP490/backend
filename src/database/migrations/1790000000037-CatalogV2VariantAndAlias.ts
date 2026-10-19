import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Additive Catalog V2 scaffolding ONLY. This migration does not create/activate
 * any bookable services, change old service IDs, seed prices, or touch 792 SKUs.
 * New price variants require exact owner-approved VND amounts before insertion.
 * No runtime code reads these tables until a separately reviewed cutover.
 */
export class CatalogV2VariantAndAlias1790000000037 implements MigrationInterface {
  name = 'CatalogV2VariantAndAlias1790000000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "service_price_variants" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "service_id" uuid NOT NULL REFERENCES "services"("id") ON DELETE RESTRICT,
        "variant_code" varchar(100) NOT NULL,
        "device_attributes" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "fixed_labor_price_vnd" bigint NOT NULL CHECK ("fixed_labor_price_vnd" >= 0),
        "included_scope" text NOT NULL,
        "excluded_scope" text NULL,
        "is_active" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_service_price_variant" UNIQUE ("service_id", "variant_code"),
        CONSTRAINT "chk_service_price_variant_attributes"
          CHECK (jsonb_typeof("device_attributes") = 'object')
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_service_price_variants_active"
      ON "service_price_variants" ("service_id", "is_active")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "service_code_aliases_v2" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "legacy_service_code" varchar(100) NOT NULL UNIQUE,
        "target_service_id" uuid NULL REFERENCES "services"("id") ON DELETE RESTRICT,
        "resolution" varchar(16) NOT NULL DEFAULT 'CLARIFY'
          CHECK ("resolution" IN ('AUTO', 'CLARIFY', 'RETIRED')),
        "notes" text NULL,
        "is_active" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_catalog_v2_alias_resolution"
          CHECK (
            ("resolution" = 'AUTO' AND "target_service_id" IS NOT NULL)
            OR ("resolution" IN ('CLARIFY', 'RETIRED'))
          )
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_service_code_aliases_v2_legacy"
      ON "service_code_aliases_v2" ("legacy_service_code", "is_active")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_service_code_aliases_v2_auto"
      ON "service_code_aliases_v2" ("legacy_service_code")
      WHERE "resolution" = 'AUTO' AND "is_active" = true`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse destructive revert if these tables have acquired real rows.
    // Down on an empty staging schema is safe; after activation use a separately
    // audited forward migration instead of dropping price/alias history. The
    // migration transaction and exclusive locks serialize this guard with writers.
    if (!queryRunner.isTransactionActive) {
      throw new Error('Catalog V2 rollback requires an active transaction');
    }
    await queryRunner.query(`
      LOCK TABLE "service_price_variants", "service_code_aliases_v2"
      IN ACCESS EXCLUSIVE MODE
    `);
    await queryRunner.query(`
      DO $catalog_guard$ BEGIN
        IF EXISTS (SELECT 1 FROM "service_price_variants" LIMIT 1)
          OR EXISTS (SELECT 1 FROM "service_code_aliases_v2" LIMIT 1)
        THEN
          RAISE EXCEPTION 'Catalog V2 staging tables contain data; refusing destructive rollback';
        END IF;
      END $catalog_guard$
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "service_code_aliases_v2"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "service_price_variants"`);
  }
}
