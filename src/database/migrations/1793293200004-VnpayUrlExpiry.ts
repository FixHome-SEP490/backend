import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 01/11/2026 (bug 39): every new VNPay URL carries vnp_ExpireDate and the attempt stores it, so an
 * abandoned attempt can be closed once the expiry plus a grace has passed. Nullable and additive:
 * older attempts keep null and are never guessed expired.
 */
export class VnpayUrlExpiry1793293200004 implements MigrationInterface {
  name = 'VnpayUrlExpiry1793293200004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "visit_group_payments" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "visit_group_payments" DROP COLUMN IF EXISTS "expires_at"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "expires_at"`);
  }
}
