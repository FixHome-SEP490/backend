/** Dedicated DEV one-off migration (check-in face review, PO 20/11/2026), runs before the W3/cash gates (they refuse unknown pending migrations). */
import 'reflect-metadata';
import dataSource from './data-source';
import { CheckinFaceReviews1794652800000 } from './migrations/1794652800000-CheckinFaceReviews';

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || process.env.CHECKIN_FACE_REVIEWS_DEV_RELEASE !== '1')
    throw new Error('Check-in face review migration requires explicit DEV release flag');

  const db = await dataSource.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    await runner.query("SELECT pg_advisory_xact_lock(hashtext('fixhome-checkin-face-reviews-v1'))");
    const migration = new CheckinFaceReviews1794652800000();
    const applied: Array<{ name: string }> = await runner.query('SELECT name FROM public.migrations WHERE name=$1', [migration.name]);
    if (!applied.length) {
      // Applied once under the advisory lock; the migration name guards a second run.
      await migration.up(runner);
      await runner.query('INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)', [1794652800000, migration.name]);
    }
    const [verified] = await runner.query(`SELECT
      to_regclass('public.checkin_face_reviews') IS NOT NULL AS has_table,
      (SELECT count(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname='idx_one_pending_checkin_face_review') AS pending_unique,
      (SELECT count(*)::int FROM public.system_configs WHERE key='checkin_face.review_sla_minutes') AS sla_config`);
    if (!verified?.has_table || verified?.pending_unique !== 1 || verified?.sla_config !== 1)
      throw new Error('Check-in face review schema verification failed');
    await runner.commitTransaction();
    console.info('Check-in face review DEV migration applied/verified');
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await db.destroy();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Check-in face review DEV release failed');
  process.exitCode = 1;
});
