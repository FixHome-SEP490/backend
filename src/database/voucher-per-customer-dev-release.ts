/** Dedicated DEV one-off migration (BUG DETECTOR 62), runs before the W3/cash gates (they refuse unknown pending migrations). */
import 'reflect-metadata';
import dataSource from './data-source';
import { VoucherPerCustomerLimit1794566400000 } from './migrations/1794566400000-VoucherPerCustomerLimit';

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || process.env.VOUCHER_PER_CUSTOMER_DEV_RELEASE !== '1')
    throw new Error('Voucher per-customer limit migration requires explicit DEV release flag');

  const db = await dataSource.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    await runner.query("SELECT pg_advisory_xact_lock(hashtext('fixhome-voucher-per-customer-v1'))");
    const migration = new VoucherPerCustomerLimit1794566400000();
    const applied: Array<{ name: string }> = await runner.query('SELECT name FROM public.migrations WHERE name=$1', [migration.name]);
    if (!applied.length) {
      // Applied once under the advisory lock; the migration name guards a second run.
      await migration.up(runner);
      await runner.query('INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)', [1794566400000, migration.name]);
    }
    const [verified] = await runner.query(`SELECT
      (SELECT column_default FROM information_schema.columns WHERE table_schema='public'
         AND table_name='voucher_campaigns' AND column_name='per_customer_limit') AS col,
      (SELECT count(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname='uq_voucher_claim_customer') AS old_unique`);
    if (!verified?.col || verified?.old_unique !== 0)
      throw new Error('Voucher per-customer limit schema verification failed');
    await runner.commitTransaction();
    console.info('Voucher per-customer limit DEV migration applied/verified');
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await db.destroy();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Voucher per-customer limit DEV release failed');
  process.exitCode = 1;
});
