import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BUG DETECTOR 261 (PO 22/11/2026): the admin sets permissions for one service manager
 * account, over the role. Nullable jsonb column on the existing user_scopes table
 * (one row per service manager); null means the account follows the role. No new table.
 */
export class ServiceManagerAccountPermissions1794739200000 implements MigrationInterface {
  name = 'ServiceManagerAccountPermissions1794739200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_scopes" ADD COLUMN IF NOT EXISTS "permission_overrides" jsonb NULL`);
    await queryRunner.query(`ALTER TABLE "user_scopes" DROP CONSTRAINT IF EXISTS "ck_user_scopes_permission_overrides"`);
    await queryRunner.query(`ALTER TABLE "user_scopes" ADD CONSTRAINT "ck_user_scopes_permission_overrides"
      CHECK ("permission_overrides" IS NULL OR jsonb_typeof("permission_overrides") = 'object')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_scopes" DROP CONSTRAINT IF EXISTS "ck_user_scopes_permission_overrides"`);
    await queryRunner.query(`ALTER TABLE "user_scopes" DROP COLUMN IF EXISTS "permission_overrides"`);
  }
}
