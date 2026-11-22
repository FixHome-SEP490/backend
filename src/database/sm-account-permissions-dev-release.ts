/** Dedicated DEV one-off migration (BUG DETECTOR 261), per-account service manager permissions, runs before the W3/cash gates (they refuse unknown pending migrations). */
import 'reflect-metadata';
import dataSource from './data-source';
import { ServiceManagerAccountPermissions1794739200000 } from './migrations/1794739200000-ServiceManagerAccountPermissions';

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || process.env.SM_ACCOUNT_PERMISSIONS_DEV_RELEASE !== '1')
    throw new Error('Service manager account permissions migration requires explicit DEV release flag');

  const db = await dataSource.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    await runner.query("SELECT pg_advisory_xact_lock(hashtext('fixhome-sm-account-permissions-v1'))");
    const migration = new ServiceManagerAccountPermissions1794739200000();
    const applied: Array<{ name: string }> = await runner.query('SELECT name FROM public.migrations WHERE name=$1', [migration.name]);
    if (!applied.length) {
      // Applied once under the advisory lock; the migration name guards a second run.
      await migration.up(runner);
      await runner.query('INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)', [1794739200000, migration.name]);
    }
    const [verified] = await runner.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public'
      AND table_name='user_scopes' AND column_name='permission_overrides'`);
    if (verified?.data_type !== 'jsonb')
      throw new Error('Service manager account permissions schema verification failed');
    await runner.commitTransaction();
    console.info('Service manager account permissions DEV migration applied/verified');
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await db.destroy();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Service manager account permissions DEV release failed');
  process.exitCode = 1;
});
