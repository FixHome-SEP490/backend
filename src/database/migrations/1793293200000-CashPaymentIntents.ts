import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive cash-first evidence. Historical cash declarations are left untouched. */
export class CashPaymentIntents1793293200000 implements MigrationInterface {
  name = 'CashPaymentIntents1793293200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE cash_payment_intents (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        scope_kind varchar(16) NOT NULL CHECK (scope_kind IN ('SOLO','VISIT_GROUP')),
        scope_id uuid NOT NULL,
        customer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        technician_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        status varchar(16) NOT NULL CHECK (status IN ('pending','cancelled','received')),
        gross_vnd bigint NOT NULL CHECK (gross_vnd > 0),
        customer_due_vnd bigint NOT NULL CHECK (customer_due_vnd > 0 AND customer_due_vnd <= gross_vnd),
        allocation_snapshot jsonb NOT NULL CHECK (jsonb_typeof(allocation_snapshot) = 'array'),
        voucher_reservation_id uuid REFERENCES voucher_reservations(id) ON DELETE RESTRICT,
        command_id uuid NOT NULL,
        receipt_command_id uuid,
        cancel_command_id uuid,
        received_amount_vnd bigint CHECK (received_amount_vnd IS NULL OR received_amount_vnd > 0),
        receipt_evidence_url text,
        received_at timestamptz,
        cash_settlement_id uuid REFERENCES cash_settlements(id) ON DELETE RESTRICT,
        visit_group_payment_id uuid REFERENCES visit_group_payments(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_cash_intent_receipt CHECK (
          (status = 'received' AND receipt_command_id IS NOT NULL AND received_amount_vnd = customer_due_vnd
            AND received_at IS NOT NULL AND ((scope_kind = 'SOLO' AND cash_settlement_id IS NOT NULL AND visit_group_payment_id IS NULL)
              OR (scope_kind = 'VISIT_GROUP' AND visit_group_payment_id IS NOT NULL AND cash_settlement_id IS NULL)))
          OR (status <> 'received' AND receipt_command_id IS NULL AND received_at IS NULL
            AND received_amount_vnd IS NULL AND cash_settlement_id IS NULL AND visit_group_payment_id IS NULL)
        )
      );
      CREATE UNIQUE INDEX uq_cash_intent_customer_command ON cash_payment_intents(customer_id, command_id);
      CREATE UNIQUE INDEX uq_cash_intent_pending_scope ON cash_payment_intents(scope_kind, scope_id)
        WHERE status = 'pending';
      CREATE UNIQUE INDEX uq_cash_intent_receipt_command ON cash_payment_intents(technician_id, receipt_command_id)
        WHERE receipt_command_id IS NOT NULL;
      CREATE INDEX idx_cash_intent_scope_created ON cash_payment_intents(scope_kind, scope_id, created_at DESC);
      CREATE FUNCTION cash_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Cash intent history cannot be deleted' USING ERRCODE = '23514';
        END IF;
        IF OLD.status <> 'pending' OR NEW.status NOT IN ('cancelled','received') OR
           NEW.scope_kind IS DISTINCT FROM OLD.scope_kind OR NEW.scope_id IS DISTINCT FROM OLD.scope_id OR
           NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.technician_id IS DISTINCT FROM OLD.technician_id OR
           NEW.gross_vnd IS DISTINCT FROM OLD.gross_vnd OR NEW.customer_due_vnd IS DISTINCT FROM OLD.customer_due_vnd OR
           NEW.allocation_snapshot IS DISTINCT FROM OLD.allocation_snapshot OR
           NEW.voucher_reservation_id IS DISTINCT FROM OLD.voucher_reservation_id OR
           NEW.command_id IS DISTINCT FROM OLD.command_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'Cash intent snapshot is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $guard$;
      CREATE TRIGGER cash_intent_guard BEFORE UPDATE OR DELETE ON cash_payment_intents
        FOR EACH ROW EXECUTE FUNCTION cash_intent_guard();
      ALTER TABLE cash_payment_intents ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON cash_payment_intents FROM PUBLIC;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          REVOKE ALL ON cash_payment_intents FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          REVOKE ALL ON cash_payment_intents FROM authenticated;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          REVOKE ALL ON cash_payment_intents FROM service_role;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ count: string }> = await queryRunner.query(
      `SELECT count(*)::text AS count FROM cash_payment_intents`,
    );
    if (Number(rows[0]?.count) !== 0) throw new Error('Cash intents contain evidence; irreversible rollback requires separate review');
    await queryRunner.query('DROP TABLE cash_payment_intents');
    await queryRunner.query('DROP FUNCTION cash_intent_guard()');
  }
}
