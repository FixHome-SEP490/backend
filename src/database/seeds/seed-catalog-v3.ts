// src/database/seeds/seed-catalog-v3.ts
// Catalog V3: bổ sung dịch vụ, biến thể giá và linh kiện vào catalog V2 đang chạy (không xoá, không tắt).
// Chạy thử (rollback): npm run seed:catalog-v3 -- --dry-run
// Chạy thật:           npm run seed:catalog-v3

import { applyCatalogV3 } from '../catalog-v2/catalog-v3-apply';

if (require.main === module) {
  (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { default: dataSource } = require('../data-source');
    const dryRun = process.argv.includes('--dry-run');
    const rollback = new Error('DRY_RUN_ROLLBACK');
    try {
      await dataSource.initialize();
      await dataSource.transaction(async (manager: Parameters<typeof applyCatalogV3>[0]) => {
        const result = await applyCatalogV3(manager);
        console.log(JSON.stringify(result, null, 1));
        if (dryRun) throw rollback;
      });
      console.log('Catalog V3: đã ghi vào DB');
    } catch (err) {
      if (err === rollback) console.log('Catalog V3: chạy thử, đã rollback');
      else { console.error('Catalog V3 lỗi:', err); process.exitCode = 1; }
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
    }
  })();
}
