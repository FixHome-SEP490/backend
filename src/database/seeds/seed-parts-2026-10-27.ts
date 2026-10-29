// src/database/seeds/seed-parts-2026-10-27.ts
// Linh kiện bổ sung 27/10/2026 (điện, đèn, nạp gas, magie, hút mùi, giá treo tivi, sen tắm). Chỉ thêm, không sửa.
// Chạy thử (rollback): npm run seed:parts-2026-10-27 -- --dry-run
// Chạy thật:           npm run seed:parts-2026-10-27

import { applyPartsAdditions20261027 } from '../catalog-v2/parts-additions-2026-10-27';

if (require.main === module) {
  (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { default: dataSource } = require('../data-source');
    const dryRun = process.argv.includes('--dry-run');
    const rollback = new Error('DRY_RUN_ROLLBACK');
    try {
      await dataSource.initialize();
      await dataSource.transaction(async (manager: Parameters<typeof applyPartsAdditions20261027>[0]) => {
        const result = await applyPartsAdditions20261027(manager);
        console.log(JSON.stringify({ inserted: result.inserted.length, skipped: result.skipped.length, ...result }, null, 1));
        if (dryRun) throw rollback;
      });
      console.log('Linh kiện 27/10: đã ghi vào DB');
    } catch (err) {
      if (err === rollback) console.log('Linh kiện 27/10: chạy thử, đã rollback');
      else { console.error('Linh kiện 27/10 lỗi:', err); process.exitCode = 1; }
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
    }
  })();
}
