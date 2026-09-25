// src/database/seeds/seed-parts-catalog-791.ts
// Seed full 791 items FixHome Part Catalog from markdown source.
// Run via: npx ts-node src/database/seeds/seed-parts-catalog-791.ts
// Also imported by run-seed.ts.

import { DataSource } from 'typeorm';
import * as partsData from './data/parts-catalog-791.json';

export interface PartCatalogItem {
  sku: string;
  name: string;
  category: string;
  group: string;
  techType: string;
  unit: string;
  spec: string;
  brands: string;
  origin: string;
  priceRange: string;
  sellingPrice: number;
  warrantyDays: number;
  warrantyPolicy: string;
  description: string;
}

export async function seedPartsCatalog791(dataSource: DataSource): Promise<{ inserted: number; updated: number; total: number }> {
  const parts: PartCatalogItem[] = Array.isArray(partsData)
    ? (partsData as PartCatalogItem[])
    : ((partsData as unknown as { default: PartCatalogItem[] }).default || []);

  const queryRunner = dataSource.createQueryRunner();
  let transactionStarted = false;
  let inserted = 0;
  let updated = 0;

  try {
    await queryRunner.connect();
    await queryRunner.startTransaction();
    transactionStarted = true;

    // Process in batches of 50 items for optimal network throughput and memory
    const BATCH_SIZE = 50;
    for (let i = 0; i < parts.length; i += BATCH_SIZE) {
      const batch = parts.slice(i, i + BATCH_SIZE);

      for (const item of batch) {
        const existing = await queryRunner.query(
          `SELECT "id" FROM "fixhome_parts" WHERE "sku" = $1`,
          [item.sku],
        );

        if (existing.length > 0) {
          await queryRunner.query(
            `UPDATE "fixhome_parts"
             SET "name" = $1,
                 "description" = $2,
                 "selling_price" = $3,
                 "warranty_days" = $4,
                 "warranty_policy" = $5,
                 "is_active" = $6,
                 "updated_at" = now()
             WHERE "sku" = $7`,
            [
              item.name,
              item.description,
              item.sellingPrice,
              item.warrantyDays,
              item.warrantyPolicy,
              true,
              item.sku,
            ],
          );
          updated++;
        } else {
          await queryRunner.query(
            `INSERT INTO "fixhome_parts" (
               "sku", "name", "description", "selling_price", "warranty_days", "warranty_policy", "is_active"
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              item.sku,
              item.name,
              item.description,
              item.sellingPrice,
              item.warrantyDays,
              item.warrantyPolicy,
              true,
            ],
          );
          inserted++;
        }
      }
    }

    await queryRunner.commitTransaction();
    console.log(`✅ Seeded FixHome Parts Catalog: ${parts.length} items (New: ${inserted}, Updated: ${updated})`);
    return { inserted, updated, total: parts.length };
  } catch (error) {
    if (transactionStarted && queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    throw error;
  } finally {
    await queryRunner.release();
  }
}

// Standalone runner
if (require.main === module) {
  (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { default: dataSource } = require('../data-source');
    try {
      console.log('🌱 Connecting to database...');
      await dataSource.initialize();
      await seedPartsCatalog791(dataSource);
      console.log('🎉 Done seeding 791 parts!');
    } catch (err) {
      console.error('❌ Failed seeding parts:', err);
      process.exit(1);
    } finally {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
    }
  })();
}
