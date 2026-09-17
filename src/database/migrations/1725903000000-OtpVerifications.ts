import { MigrationInterface, QueryRunner } from 'typeorm';

export class OtpVerifications1725903000000 implements MigrationInterface {
  name = 'OtpVerifications1725903000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "otp_verifications" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "email" VARCHAR(255) NOT NULL,
        "code_hash" VARCHAR(255) NOT NULL,
        "purpose" VARCHAR(50) NOT NULL,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "max_attempts" INTEGER NOT NULL DEFAULT 5,
        "is_used" BOOLEAN NOT NULL DEFAULT false,
        "resend_available_at" TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS "idx_otp_verifications_email_purpose" 
        ON "otp_verifications" ("email", "purpose");

      ALTER TABLE "users" 
        ADD COLUMN IF NOT EXISTS "is_email_verified" BOOLEAN NOT NULL DEFAULT false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "is_email_verified";
      DROP TABLE IF EXISTS "otp_verifications";
    `);
  }
}
