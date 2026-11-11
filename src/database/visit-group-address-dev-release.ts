/** Dedicated DEV one-off migration (BUG DETECTOR 59), runs before the W3/cash gates (they refuse unknown pending migrations). */
import 'reflect-metadata';
import dataSource from './data-source';
import { VisitGroupAddressSetNull1794393600000 } from './migrations/1794393600000-VisitGroupAddressSetNull';

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || process.env.VISIT_GROUP_ADDRESS_DEV_RELEASE !== '1')
    throw new Error('Visit group address migration requires explicit DEV release flag');

  const db = await dataSource.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    await runner.query("SELECT pg_advisory_xact_lock(hashtext('fixhome-visit-group-address-v1'))");
    const migration = new VisitGroupAddressSetNull1794393600000();
    const applied: Array<{ name: string }> = await runner.query('SELECT name FROM public.migrations WHERE name=$1', [migration.name]);
    if (!applied.length) {
      // Idempotent: DROP NOT NULL and DROP CONSTRAINT IF EXISTS + ADD can run over a hand-applied schema.
      await migration.up(runner);
      await runner.query('INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)', [1794393600000, migration.name]);
    }
    const [verified] = await runner.query(`SELECT
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public'
         AND table_name='visit_groups' AND column_name='address_id') AS nullable,
      (SELECT confdeltype FROM pg_constraint WHERE conname='visit_groups_address_id_fkey'
         AND conrelid='public.visit_groups'::regclass) AS on_delete`);
    if (verified?.nullable !== 'YES' || verified?.on_delete !== 'n')
      throw new Error('Visit group address schema verification failed');
    await runner.commitTransaction();
    console.info('Visit group address DEV migration applied/verified');
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await db.destroy();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Visit group address DEV release failed');
  process.exitCode = 1;
});
