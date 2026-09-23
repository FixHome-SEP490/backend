import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `technician_schedules` and `addresses` had no unique constraint backing the
 * seed script's `ON CONFLICT DO NOTHING` — Postgres needs a matching
 * constraint/index target for that clause to actually dedupe anything, so
 * every re-run of the demo seed silently re-inserted a full set of rows
 * (some technicians ended up with 30 schedule rows instead of 6). That
 * cartesian-product blow-up in `technician_profiles` -> skills/serviceAreas/
 * schedules multi-relation joins is what made `GET /technicians/me/profile`
 * hang indefinitely for accounts with heavily-duplicated schedules.
 */
export class DedupeAndConstrainScheduleAndAddress1790000000003 implements MigrationInterface {
  name = 'DedupeAndConstrainScheduleAndAddress1790000000003';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DELETE FROM technician_schedules
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY technician_id, day_of_week ORDER BY created_at, id
          ) AS rn
          FROM technician_schedules
        ) ranked WHERE rn > 1
      );
    `);
    await q.query(`
      ALTER TABLE technician_schedules
        ADD CONSTRAINT uq_tech_schedule_day UNIQUE (technician_id, day_of_week);
    `);

    await q.query(`
      DELETE FROM addresses
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY user_id ORDER BY created_at, id
          ) AS rn
          FROM addresses WHERE is_default = true
        ) ranked WHERE rn > 1
      );
    `);
    await q.query(`
      CREATE UNIQUE INDEX uq_addresses_one_default_per_user
        ON addresses (user_id) WHERE is_default = true;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX uq_addresses_one_default_per_user;`);
    await q.query(`ALTER TABLE technician_schedules DROP CONSTRAINT uq_tech_schedule_day;`);
  }
}
