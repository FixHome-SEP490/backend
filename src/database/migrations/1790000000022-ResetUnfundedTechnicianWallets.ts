import { MigrationInterface, QueryRunner } from 'typeorm';

export class ResetUnfundedTechnicianWallets1790000000022 implements MigrationInterface {
  name = 'ResetUnfundedTechnicianWallets1790000000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Reset initial balance to 0 for all self-registered technicians who have no real transactions
    // (excluding pre-seeded demo accounts tech1@fixhome.vn through tech12@fixhome.vn)
    await queryRunner.query(`
      UPDATE "wallets"
      SET "balance" = 0, "updated_at" = now()
      WHERE "technician_id" IN (
        SELECT u.id
        FROM "users" u
        WHERE u.role = 'technician'
          AND u.email NOT LIKE 'tech%@fixhome.vn'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "wallet_transactions" wt
        WHERE wt.wallet_id = "wallets".id
      );
    `);

    // Reset shift status to unavailable for unfunded real technicians
    await queryRunner.query(`
      UPDATE "technician_profiles"
      SET "is_available" = false, "updated_at" = now()
      WHERE "user_id" IN (
        SELECT w.technician_id
        FROM "wallets" w
        WHERE w.balance < 200000
      )
      AND "user_id" NOT IN (
        SELECT id FROM "users" WHERE email LIKE 'tech%@fixhome.vn'
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Non-destructive: down migration does not re-inflate unfunded balances
  }
}
