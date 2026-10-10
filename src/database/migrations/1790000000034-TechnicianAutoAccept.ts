import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 10/10/2026: a technician can switch on "tự nhận việc"; an invitation that reaches them is
 * then accepted for them, under the same rules as their own Accept. Off by default.
 */
export class TechnicianAutoAccept1790000000034 implements MigrationInterface {
  name = 'TechnicianAutoAccept1790000000034';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "technician_profiles" ADD COLUMN IF NOT EXISTS "auto_accept_invitations" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "technician_profiles" DROP COLUMN IF EXISTS "auto_accept_invitations"`);
  }
}
