import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 21/10/2026 (G0-4 4B): a visit of several devices is paid once, by VNPay
 * (one provider transaction), the customer wallet (one debit) or cash (one
 * collection the customer confirms). Each attempt freezes how its amount splits
 * over the devices' invoices (allocations); a visit has at most one verified
 * payment, whatever the rail.
 */
export class VisitGroupPayments1790000000052 implements MigrationInterface {
  name = 'VisitGroupPayments1790000000052';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "visit_group_payments" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "visit_group_id" uuid NOT NULL REFERENCES "visit_groups"("id"),
        "rail" varchar(8) NOT NULL,
        "status" varchar(24) NOT NULL,
        "amount" bigint NOT NULL,
        "allocations" jsonb NOT NULL,
        "idempotency_key" varchar(128) NOT NULL,
        "provider_reference" varchar(255),
        "requested_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
        "requested_at" timestamptz NOT NULL DEFAULT now(),
        "verified_at" timestamptz,
        "failure_code" varchar(64),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_visit_group_payments_rail" CHECK ("rail" IN ('vnpay', 'wallet', 'cash')),
        CONSTRAINT "chk_visit_group_payments_status" CHECK ("status" IN ('pending', 'pending_confirmation', 'verified', 'failed', 'cancelled', 'disputed')),
        CONSTRAINT "chk_visit_group_payments_amount" CHECK ("amount" > 0)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_visit_group_payments_idempotency" ON "visit_group_payments" ("idempotency_key")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_visit_group_payments_verified" ON "visit_group_payments" ("visit_group_id") WHERE "status" = 'verified'`);
    await queryRunner.query(`CREATE INDEX "idx_visit_group_payments_group" ON "visit_group_payments" ("visit_group_id", "created_at" DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "visit_group_payments"`);
  }
}
