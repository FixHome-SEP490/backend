import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reputation points (PO 08/10/2026) for customers and technicians. Everyone
 * starts at 100; cancelling an order a technician already holds costs
 * `reputation.violation_points`. The score decides the ban (below 70: 72
 * hours, below 40: 7 days, 20 or less: 30 days, 0: locked for good) and goes
 * back to 100 every `reputation.reset_months` months. Each change is kept in
 * reputation_events so staff can see why a score moved.
 */
export class ReputationPoints1790000000030 implements MigrationInterface {
  name = 'ReputationPoints1790000000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reputation_points" integer NOT NULL DEFAULT 100`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reputation_period_start" timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "users" ADD CONSTRAINT "CHK_users_reputation_points" CHECK ("reputation_points" BETWEEN 0 AND 100);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reputation_events" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "kind" varchar(20) NOT NULL CHECK ("kind" IN ('violation', 'adjustment', 'reset')),
        "delta" integer NOT NULL,
        "points_after" integer NOT NULL,
        "reason" text NOT NULL,
        "penalty" varchar(40) NULL,
        "service_order_id" UUID NULL,
        "cancellation_id" UUID NULL,
        "actor_user_id" UUID NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_reputation_events_user_created" ON "reputation_events" ("user_id", "created_at")`);
    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "value_type", "description")
      VALUES
        ('reputation.violation_points', '10', 'int',
         'Số điểm uy tín bị trừ mỗi lần huỷ đơn đã có thợ nhận (khách hoặc thợ)'),
        ('reputation.reset_months', '2', 'int',
         'Điểm uy tín về lại 100 sau bấy nhiêu tháng (tài khoản đã khoá thì giữ nguyên)')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "system_configs" WHERE "key" IN ('reputation.violation_points', 'reputation.reset_months')`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reputation_events"`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "CHK_users_reputation_points"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "reputation_period_start"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "reputation_points"`);
  }
}
