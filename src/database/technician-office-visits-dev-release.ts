/** Dedicated DEV one-off migration, runs before the W3/cash gates (they refuse unknown pending migrations). */
import 'reflect-metadata';
import dataSource from './data-source';
import { TechnicianOfficeVisits1794220800000 } from './migrations/1794220800000-TechnicianOfficeVisits';

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || process.env.TECHNICIAN_OFFICE_VISITS_DEV_RELEASE !== '1')
    throw new Error('Technician office visits migration requires explicit DEV release flag');

  const db = await dataSource.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    await runner.query("SELECT pg_advisory_xact_lock(hashtext('fixhome-technician-office-visits-v1'))");
    const migration = new TechnicianOfficeVisits1794220800000();
    const applied: Array<{ name: string }> = await runner.query('SELECT name FROM public.migrations WHERE name=$1', [migration.name]);
    if (!applied.length) {
      // The migration is idempotent (IF NOT EXISTS / ON CONFLICT), so a hand-applied schema is simply recorded.
      await migration.up(runner);
      await runner.query('INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)', [1794220800000, migration.name]);
    }
    const [verified] = await runner.query(`SELECT
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'
         AND table_name IN ('technician_visit_offices','technician_office_visits'))::integer AS tables,
      (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public'
         AND ((table_name='technician_skills' AND column_name='declared_level')
           OR (table_name='technician_profiles' AND column_name IN ('identity_verified_at','profile_review_rejection_reason'))))::integer AS columns,
      (SELECT COUNT(*) FROM public.system_configs WHERE key LIKE 'office.%')::integer AS configs`);
    if (Number(verified.tables) !== 2 || Number(verified.columns) !== 3 || Number(verified.configs) < 4)
      throw new Error('Technician office visits schema verification failed');
    await runner.commitTransaction();
    console.info('Technician office visits DEV migration applied/verified');
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await db.destroy();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Technician office visits DEV release failed');
  process.exitCode = 1;
});
