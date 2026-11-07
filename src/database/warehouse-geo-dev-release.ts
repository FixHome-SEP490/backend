/** Dedicated DEV one-off migration, runs before existing W3/cash gates. */
import 'reflect-metadata';
import dataSource from './data-source';
import { WarehouseNearestGeo1794048000000 } from './migrations/1794048000000-WarehouseNearestGeo';

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || process.env.WAREHOUSE_GEO_DEV_RELEASE !== '1')
    throw new Error('Warehouse geo migration requires explicit DEV release flag');

  const db = await dataSource.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    await runner.query("SELECT pg_advisory_xact_lock(hashtext('fixhome-warehouse-geo-v1'))");
    const migration = new WarehouseNearestGeo1794048000000();
    const applied: Array<{ name: string }> = await runner.query(
      'SELECT name FROM public.migrations WHERE name=$1', [migration.name],
    );
    if (!applied.length) {
      const [existing] = await runner.query(`SELECT COUNT(*)::integer AS count FROM information_schema.columns
        WHERE table_schema='public' AND table_name='warehouses'
        AND column_name IN ('latitude','longitude')`);
      if (Number(existing.count) !== 0) throw new Error('Warehouse geo schema partially exists without migration ledger');
      await migration.up(runner);
      await runner.query('INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)', [1794048000000, migration.name]);
    }
    const [verified] = await runner.query(`SELECT
      (SELECT COUNT(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='warehouses' AND column_name IN ('latitude','longitude'))::integer AS columns,
      (SELECT COUNT(*) FROM pg_constraint WHERE conrelid='public.warehouses'::regclass
       AND conname='chk_warehouse_coordinates')::integer AS guards`);
    if (Number(verified.columns) !== 2 || Number(verified.guards) !== 1) throw new Error('Warehouse geo schema verification failed');
    await runner.commitTransaction();
    console.info('Warehouse geo DEV migration applied/verified');
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await db.destroy();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Warehouse geo DEV release failed');
  process.exitCode = 1;
});
