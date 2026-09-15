import { DataSource } from 'typeorm';

export const DEMO_PART_CATALOG = {
  sku: 'FH-BOARD-X',
  name: 'Board X',
  sellingPrice: 700000,
  warrantyDays: 90,
  isActive: true,
} as const;

/** Seed the single bounded Part Catalog demo fixture by its stable SKU. */
export async function seedPartsCatalog(dataSource: DataSource): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  let transactionStarted = false;

  try {
    await queryRunner.connect();
    await queryRunner.startTransaction();
    transactionStarted = true;

    const existing = await queryRunner.query(
      `SELECT "id" FROM "fixhome_parts" WHERE "sku" = $1`,
      [DEMO_PART_CATALOG.sku],
    );

    if (existing.length > 0) {
      await queryRunner.query(
        `UPDATE "fixhome_parts"
         SET "name" = $1, "selling_price" = $2, "warranty_days" = $3, "is_active" = $4, "updated_at" = now()
         WHERE "sku" = $5`,
        [
          DEMO_PART_CATALOG.name,
          DEMO_PART_CATALOG.sellingPrice,
          DEMO_PART_CATALOG.warrantyDays,
          DEMO_PART_CATALOG.isActive,
          DEMO_PART_CATALOG.sku,
        ],
      );
    } else {
      await queryRunner.query(
        `INSERT INTO "fixhome_parts" ("sku", "name", "selling_price", "warranty_days", "is_active")
         VALUES ($1, $2, $3, $4, $5)`,
        [
          DEMO_PART_CATALOG.sku,
          DEMO_PART_CATALOG.name,
          DEMO_PART_CATALOG.sellingPrice,
          DEMO_PART_CATALOG.warrantyDays,
          DEMO_PART_CATALOG.isActive,
        ],
      );
    }

    await queryRunner.commitTransaction();
    console.log('✅ Seeded Part Catalog demo fixture: FH-BOARD-X');
  } catch (error) {
    if (transactionStarted && queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    throw error;
  } finally {
    await queryRunner.release();
  }
}
