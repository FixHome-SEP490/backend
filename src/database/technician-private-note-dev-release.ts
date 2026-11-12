/** Dedicated DEV one-off migration (TECH 42), runs before the W3/cash gates (they refuse unknown pending migrations). */
import 'reflect-metadata';
import dataSource from './data-source';
import { TechnicianPrivateNote1794480000000 } from './migrations/1794480000000-TechnicianPrivateNote';

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || process.env.TECHNICIAN_PRIVATE_NOTE_DEV_RELEASE !== '1')
    throw new Error('Technician private note migration requires explicit DEV release flag');

  const db = await dataSource.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    await runner.query("SELECT pg_advisory_xact_lock(hashtext('fixhome-technician-private-note-v1'))");
    const migration = new TechnicianPrivateNote1794480000000();
    const applied: Array<{ name: string }> = await runner.query('SELECT name FROM public.migrations WHERE name=$1', [migration.name]);
    if (!applied.length) {
      // Idempotent: ADD COLUMN IF NOT EXISTS; the CHECK is added only when missing.
      await migration.up(runner);
      await runner.query('INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)', [1794480000000, migration.name]);
    }
    const [verified] = await runner.query(`SELECT
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public'
         AND table_name='technician_assignments' AND column_name='private_note') AS nullable,
      (SELECT count(*)::int FROM pg_constraint WHERE conname='chk_technician_assignment_private_note_length'
         AND conrelid='public.technician_assignments'::regclass) AS checks`);
    if (verified?.nullable !== 'YES' || verified?.checks !== 1)
      throw new Error('Technician private note schema verification failed');
    await runner.commitTransaction();
    console.info('Technician private note DEV migration applied/verified');
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await db.destroy();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Technician private note DEV release failed');
  process.exitCode = 1;
});
