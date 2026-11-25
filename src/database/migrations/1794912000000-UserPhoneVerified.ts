import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 25/11/2026: OTP qua SMS. A user can verify the phone number as well as the email, so the account
 * needs its own flag. Additive: one boolean column, existing rows start unverified.
 */
export class UserPhoneVerified1794912000000 implements MigrationInterface {
  name = 'UserPhoneVerified1794912000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_phone_verified" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "is_phone_verified"`);
  }
}
