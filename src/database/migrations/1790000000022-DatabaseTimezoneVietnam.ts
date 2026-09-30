import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Show and cut days in Vietnam time at the database level.
 *
 * Every event column is timestamptz, so the stored instants do not change: this
 * only sets the session default, which is what the Supabase table editor and
 * SQL editor display in, and what `::date` or `date_trunc('day', ...)` use to
 * decide where a day starts. It takes effect on new connections.
 */
export class DatabaseTimezoneVietnam1790000000022 implements MigrationInterface {
  name = 'DatabaseTimezoneVietnam1790000000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Ho_Chi_Minh');
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        EXECUTE format('ALTER DATABASE %I RESET timezone', current_database());
      END
      $$;
    `);
  }
}
