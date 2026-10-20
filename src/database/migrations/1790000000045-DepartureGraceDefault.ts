import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BRX-063: with a 0-minute grace an order accepted after the appointment window
 * had started was warned immediately. The grace is now 15 minutes, counted from
 * the later of the window start and the acceptance. Only the old default (0) is
 * changed; a value an Admin already set is left alone.
 */
export class DepartureGraceDefault1790000000045 implements MigrationInterface {
  name = 'DepartureGraceDefault1790000000045';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "system_configs" SET "value" = '15' WHERE "key" = 'order.departure_grace_minutes' AND "value" = '0'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "system_configs" SET "value" = '0' WHERE "key" = 'order.departure_grace_minutes' AND "value" = '15'`);
  }
}
