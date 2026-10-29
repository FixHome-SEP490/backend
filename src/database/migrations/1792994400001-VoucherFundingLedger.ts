import { MigrationInterface, QueryRunner } from 'typeorm';

/** F4 only: immutable funding evidence. No existing money row or voucher history is rewritten. */
export class VoucherFundingLedger1792994400001 implements MigrationInterface {
  name = 'VoucherFundingLedger1792994400001';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE UNIQUE INDEX uq_voucher_reservation_link_identity
        ON public.voucher_reservations(id, attempt_id, customer_id, scope_id);

      CREATE TABLE public.voucher_payment_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(),
        reservation_id uuid NOT NULL UNIQUE,
        attempt_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        scope_id uuid NOT NULL,
        scope_kind varchar(16) NOT NULL CHECK (scope_kind IN ('SOLO','VISIT_GROUP')),
        rail varchar(8) NOT NULL CHECK (rail IN ('WALLET','VNPAY','CASH','ZERO')),
        payment_id uuid UNIQUE REFERENCES public.payments(id) ON DELETE RESTRICT,
        cash_settlement_id uuid UNIQUE REFERENCES public.cash_settlements(id) ON DELETE RESTRICT,
        visit_group_payment_id uuid UNIQUE REFERENCES public.visit_group_payments(id) ON DELETE RESTRICT,
        provider_txn_ref varchar(128) UNIQUE,
        provider_initiated_at timestamptz,
        original_gross_vnd bigint NOT NULL CHECK (original_gross_vnd > 0),
        eligible_base_vnd bigint NOT NULL CHECK (eligible_base_vnd > 0),
        subsidy_vnd bigint NOT NULL CHECK (subsidy_vnd > 0),
        customer_due_vnd bigint NOT NULL CHECK (customer_due_vnd >= 0),
        allocation_snapshot jsonb NOT NULL CHECK (
          jsonb_typeof(allocation_snapshot) = 'array' AND jsonb_array_length(allocation_snapshot) > 0
        ),
        allocation_sha256 char(64) NOT NULL CHECK (allocation_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT fk_voucher_link_reservation FOREIGN KEY
          (reservation_id,attempt_id,customer_id,scope_id)
          REFERENCES public.voucher_reservations(id,attempt_id,customer_id,scope_id) ON DELETE RESTRICT,
        CONSTRAINT ck_voucher_link_funding CHECK (
          subsidy_vnd <= eligible_base_vnd AND eligible_base_vnd <= original_gross_vnd
          AND customer_due_vnd = original_gross_vnd - subsidy_vnd
        ),
        CONSTRAINT ck_voucher_link_payment CHECK (
          (rail = 'ZERO' AND customer_due_vnd = 0 AND payment_id IS NULL
            AND cash_settlement_id IS NULL AND visit_group_payment_id IS NULL)
          OR (rail <> 'ZERO' AND customer_due_vnd > 0
            AND ((scope_kind = 'SOLO' AND rail = 'CASH' AND cash_settlement_id IS NOT NULL
              AND payment_id IS NULL AND visit_group_payment_id IS NULL)
              OR (scope_kind = 'SOLO' AND rail <> 'CASH' AND payment_id IS NOT NULL
                AND cash_settlement_id IS NULL AND visit_group_payment_id IS NULL)
              OR (scope_kind = 'VISIT_GROUP' AND visit_group_payment_id IS NOT NULL
                AND payment_id IS NULL AND cash_settlement_id IS NULL)))
        ),
        CONSTRAINT ck_voucher_link_provider CHECK (
          (rail = 'VNPAY' AND provider_txn_ref IS NOT NULL AND provider_initiated_at IS NOT NULL)
          OR (rail <> 'VNPAY' AND provider_txn_ref IS NULL AND provider_initiated_at IS NULL)
        )
      );
      CREATE INDEX idx_voucher_links_customer_scope
        ON public.voucher_payment_links(customer_id,scope_id);
      CREATE INDEX idx_voucher_links_allocations
        ON public.voucher_payment_links USING GIN (allocation_snapshot jsonb_path_ops);

      CREATE TABLE public.voucher_funding_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(),
        link_id uuid NOT NULL REFERENCES public.voucher_payment_links(id) ON DELETE RESTRICT,
        invoice_id uuid REFERENCES public.invoices(id) ON DELETE RESTRICT,
        kind varchar(32) NOT NULL CHECK (kind IN (
          'PROVIDER_PENDING','PROVIDER_PAID','PROVIDER_FAILED','QUARANTINED',
          'SUBSIDY_COMMITTED','CASH_TECH_CREDIT','CUSTOMER_REFUND',
          'SUBSIDY_REVERSAL','QUOTA_RESTORED'
        )),
        amount_vnd bigint NOT NULL CHECK (amount_vnd >= 0),
        idempotency_key varchar(160) NOT NULL UNIQUE,
        provider_reference varchar(255),
        provider_paid_at timestamptz,
        evidence_sha256 char(64) CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
        wallet_transaction_id uuid REFERENCES public.wallet_transactions(id) ON DELETE RESTRICT,
        customer_wallet_transaction_id uuid REFERENCES public.customer_wallet_transactions(id) ON DELETE RESTRICT,
        refund_source_id uuid,
        CONSTRAINT ck_voucher_entry_invoice CHECK (
          (kind IN ('PROVIDER_PENDING','PROVIDER_PAID','PROVIDER_FAILED','QUARANTINED','QUOTA_RESTORED')
            AND invoice_id IS NULL)
          OR (kind IN ('SUBSIDY_COMMITTED','CASH_TECH_CREDIT','CUSTOMER_REFUND','SUBSIDY_REVERSAL')
            AND invoice_id IS NOT NULL)
        ),
         CONSTRAINT ck_voucher_entry_money_link CHECK (
           (kind NOT IN ('SUBSIDY_COMMITTED','CASH_TECH_CREDIT','CUSTOMER_REFUND','SUBSIDY_REVERSAL') OR amount_vnd > 0)
           AND
           (wallet_transaction_id IS NULL OR kind IN ('CASH_TECH_CREDIT','SUBSIDY_REVERSAL'))
          AND (kind <> 'CASH_TECH_CREDIT' OR wallet_transaction_id IS NOT NULL)
          AND (kind = 'CUSTOMER_REFUND') = (customer_wallet_transaction_id IS NOT NULL)
          AND (kind NOT IN ('CUSTOMER_REFUND','SUBSIDY_REVERSAL','QUOTA_RESTORED')
            OR refund_source_id IS NOT NULL)
          AND (kind <> 'QUOTA_RESTORED' OR amount_vnd = 0)
        ),
        CONSTRAINT ck_voucher_entry_provider CHECK (
          (kind = 'PROVIDER_PAID' AND provider_reference IS NOT NULL
            AND provider_paid_at IS NOT NULL AND evidence_sha256 IS NOT NULL)
          OR (kind = 'QUARANTINED' AND (provider_paid_at IS NULL OR evidence_sha256 IS NOT NULL))
          OR (kind NOT IN ('PROVIDER_PAID','QUARANTINED') AND provider_paid_at IS NULL)
        )
      );
      CREATE UNIQUE INDEX uq_voucher_entry_once_per_invoice
        ON public.voucher_funding_entries(link_id,invoice_id,kind)
        WHERE kind IN ('SUBSIDY_COMMITTED','CASH_TECH_CREDIT');
      CREATE UNIQUE INDEX uq_voucher_entry_quota_restore
        ON public.voucher_funding_entries(link_id) WHERE kind = 'QUOTA_RESTORED';
      CREATE UNIQUE INDEX uq_voucher_entry_terminal_provider
        ON public.voucher_funding_entries(link_id)
        WHERE kind IN ('PROVIDER_PAID','PROVIDER_FAILED');
      CREATE INDEX idx_voucher_entries_link
        ON public.voucher_funding_entries(link_id,kind,invoice_id);
      CREATE INDEX idx_voucher_entries_invoice
        ON public.voucher_funding_entries(invoice_id)
        WHERE invoice_id IS NOT NULL;
      CREATE UNIQUE INDEX uq_voucher_entry_wallet_transaction
        ON public.voucher_funding_entries(wallet_transaction_id)
        WHERE wallet_transaction_id IS NOT NULL;
      CREATE UNIQUE INDEX uq_voucher_entry_customer_wallet_transaction
        ON public.voucher_funding_entries(customer_wallet_transaction_id,invoice_id)
        WHERE customer_wallet_transaction_id IS NOT NULL;
      CREATE INDEX idx_voucher_entries_refund_source
        ON public.voucher_funding_entries(refund_source_id) WHERE refund_source_id IS NOT NULL;

      CREATE FUNCTION public.voucher_funding_append_only() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'Voucher funding history is append-only' USING ERRCODE = '23514';
        END $$;
      CREATE TRIGGER voucher_link_append_only BEFORE UPDATE OR DELETE
        ON public.voucher_payment_links FOR EACH ROW EXECUTE FUNCTION public.voucher_funding_append_only();
      CREATE TRIGGER voucher_entry_append_only BEFORE UPDATE OR DELETE
        ON public.voucher_funding_entries FOR EACH ROW EXECUTE FUNCTION public.voucher_funding_append_only();

      ALTER TABLE public.voucher_payment_links ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.voucher_funding_entries ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.voucher_payment_links, public.voucher_funding_entries FROM PUBLIC;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          REVOKE ALL ON public.voucher_payment_links, public.voucher_funding_entries FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          REVOKE ALL ON public.voucher_payment_links, public.voucher_funding_entries FROM authenticated;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          REVOKE ALL ON public.voucher_payment_links, public.voucher_funding_entries FROM service_role;
        END IF;
      END $$;

      -- F3: manager-approved original gross is separate from the NET wallet credit.
      ALTER TABLE public.support_cases
        ADD COLUMN voucher_gross_refund_vnd bigint NULL
        CONSTRAINT ck_support_case_voucher_gross_refund CHECK
          (voucher_gross_refund_vnd IS NULL OR voucher_gross_refund_vnd > 0);
      -- Forward F3 policy: historical settlement IDs remain immutable.
      ALTER TABLE public.voucher_reservations
        DROP CONSTRAINT voucher_reservations_state_check;
      ALTER TABLE public.voucher_reservations
        ADD CONSTRAINT voucher_reservations_state_check
          CHECK (state IN ('RESERVED','RELEASED','EXPIRED','REDEEMED','REFUNDED'));
      ALTER TABLE public.voucher_reservations
        DROP CONSTRAINT ck_voucher_reservation_settlement;
      ALTER TABLE public.voucher_reservations
        ADD CONSTRAINT ck_voucher_reservation_settlement
          CHECK ((state IN ('REDEEMED','REFUNDED')) = (settlement_id IS NOT NULL));

      CREATE FUNCTION public.voucher_full_refund_verified(p_reservation_id uuid)
        RETURNS boolean LANGUAGE sql STABLE AS $refund$
        SELECT EXISTS (
          SELECT 1 FROM public.voucher_reservations r
          JOIN public.voucher_payment_links l ON l.reservation_id = r.id
          WHERE r.id = p_reservation_id AND r.state = 'REDEEMED'
            AND EXISTS (
              SELECT 1 FROM public.voucher_funding_entries q
              WHERE q.link_id = l.id AND q.kind = 'QUOTA_RESTORED'
                AND q.invoice_id IS NULL AND q.amount_vnd = 0
            )
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(l.allocation_snapshot) a
              LEFT JOIN LATERAL (
                SELECT COALESCE(SUM(e.amount_vnd) FILTER (WHERE e.kind = 'CUSTOMER_REFUND'),0) AS customer,
                  COALESCE(SUM(e.amount_vnd) FILTER (WHERE e.kind = 'SUBSIDY_REVERSAL'),0) AS subsidy
                FROM public.voucher_funding_entries e
                WHERE e.link_id = l.id AND e.invoice_id = (a->>'invoiceId')::uuid
              ) totals ON true
              WHERE totals.customer IS DISTINCT FROM (a->>'customerDueVnd')::bigint
                OR totals.subsidy IS DISTINCT FROM (a->>'subsidyVnd')::bigint
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.voucher_funding_entries e
              WHERE e.link_id = l.id AND e.kind IN ('CUSTOMER_REFUND','SUBSIDY_REVERSAL')
                AND NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(l.allocation_snapshot) a
                  WHERE a->>'invoiceId' = e.invoice_id::text
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.voucher_funding_entries e
              LEFT JOIN public.customer_wallet_transactions t ON t.id = e.customer_wallet_transaction_id
              LEFT JOIN public.customer_wallets w ON w.id = t.wallet_id
              LEFT JOIN public.invoices i ON i.id = e.invoice_id
              WHERE e.link_id = l.id AND e.kind = 'CUSTOMER_REFUND'
                AND (t.id IS NULL OR w.id IS NULL OR i.id IS NULL
                  OR t.type IS DISTINCT FROM 'refund'
                  OR t.balance_after - t.balance_before IS DISTINCT FROM t.amount
                  OR w.user_id IS DISTINCT FROM l.customer_id
                  OR ((t.reference_type = 'SERVICE_ORDER' AND t.reference_id = i.service_order_id::text)
                    OR (l.scope_kind = 'VISIT_GROUP' AND t.reference_type = 'VISIT_GROUP'
                      AND t.reference_id = l.scope_id::text)) IS NOT TRUE
                  OR (SELECT COALESCE(SUM(allocation.amount_vnd),0)
                      FROM public.voucher_funding_entries allocation
                      WHERE allocation.link_id = l.id AND allocation.kind = 'CUSTOMER_REFUND'
                        AND allocation.customer_wallet_transaction_id = t.id) IS DISTINCT FROM t.amount)
            )
            AND (l.rail <> 'CASH' OR NOT EXISTS (
              SELECT 1 FROM public.voucher_funding_entries e
              LEFT JOIN public.wallet_transactions t ON t.id = e.wallet_transaction_id
              LEFT JOIN public.voucher_funding_entries credit
                ON credit.link_id = e.link_id AND credit.invoice_id = e.invoice_id
                  AND credit.kind = 'CASH_TECH_CREDIT'
              LEFT JOIN public.wallet_transactions paid_credit
                ON paid_credit.id = credit.wallet_transaction_id
              WHERE e.link_id = l.id AND e.kind = 'SUBSIDY_REVERSAL'
                AND (t.id IS NULL OR paid_credit.id IS NULL
                  OR t.wallet_id <> paid_credit.wallet_id
                  OR t.type::text <> 'ADJUSTMENT'
                  OR t.reference_type IS DISTINCT FROM 'VOUCHER_REFUND'
                  OR t.reference_id IS DISTINCT FROM e.refund_source_id::text
                  OR t.balance_before - t.balance_after <> e.amount_vnd)
            ))
        )
      $refund$;

      CREATE OR REPLACE FUNCTION public.voucher_guard_write() RETURNS trigger
        LANGUAGE plpgsql AS $$
      DECLARE c public.voucher_campaigns%ROWTYPE; claim public.voucher_claims%ROWTYPE; held bigint;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Voucher history cannot be deleted' USING ERRCODE = '23514';
        END IF;
        IF TG_TABLE_NAME = 'voucher_audit' THEN
          RAISE EXCEPTION 'Voucher audit is append-only' USING ERRCODE = '23514';
        ELSIF TG_TABLE_NAME = 'voucher_campaigns' THEN
          IF ROW(NEW.id,NEW.created_at,NEW.code,NEW.name,NEW.kind,NEW.policy,NEW.starts_at,NEW.ends_at,NEW.quota,NEW.auto_compensation)
            IS DISTINCT FROM ROW(OLD.id,OLD.created_at,OLD.code,OLD.name,OLD.kind,OLD.policy,OLD.starts_at,OLD.ends_at,OLD.quota,OLD.auto_compensation)
            THEN RAISE EXCEPTION 'Voucher campaign policy is immutable' USING ERRCODE = '23514'; END IF;
        ELSIF TG_TABLE_NAME = 'voucher_claims' THEN
          IF TG_OP = 'INSERT' THEN
            SELECT * INTO c FROM public.voucher_campaigns WHERE id = NEW.campaign_id FOR UPDATE;
            IF NOT FOUND OR NEW.policy_snapshot IS DISTINCT FROM c.policy OR NEW.redeemed_at IS NOT NULL
              OR NOT c.active OR clock_timestamp() < c.starts_at OR clock_timestamp() >= c.ends_at THEN
              RAISE EXCEPTION 'Invalid voucher claim snapshot' USING ERRCODE = '23514'; END IF;
          ELSE
            IF ROW(NEW.id,NEW.created_at,NEW.campaign_id,NEW.campaign_kind,NEW.customer_id,NEW.source_kind,NEW.source_id,NEW.source_key,NEW.policy_snapshot)
              IS DISTINCT FROM ROW(OLD.id,OLD.created_at,OLD.campaign_id,OLD.campaign_kind,OLD.customer_id,OLD.source_kind,OLD.source_id,OLD.source_key,OLD.policy_snapshot)
              OR (OLD.redeemed_at IS NOT NULL AND NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at
                AND NOT (NEW.redeemed_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM public.voucher_reservations active
                    WHERE active.claim_id = OLD.id AND active.state = 'REDEEMED')
                  AND EXISTS (SELECT 1 FROM public.voucher_reservations refunded
                    JOIN public.voucher_payment_links l ON l.reservation_id = refunded.id
                    JOIN public.voucher_funding_entries q ON q.link_id = l.id AND q.kind = 'QUOTA_RESTORED'
                    WHERE refunded.claim_id = OLD.id AND refunded.state = 'REFUNDED')))
              THEN RAISE EXCEPTION 'Voucher claim identity is immutable' USING ERRCODE = '23514'; END IF;
          END IF;
        ELSIF TG_TABLE_NAME = 'voucher_reservations' THEN
          SELECT * INTO c FROM public.voucher_campaigns WHERE id = NEW.campaign_id FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'Unknown voucher campaign' USING ERRCODE = '23514'; END IF;
          IF TG_OP = 'INSERT' THEN
            SELECT * INTO claim FROM public.voucher_claims WHERE id = NEW.claim_id;
            SELECT count(*) INTO held FROM public.voucher_reservations WHERE campaign_id = c.id AND state = 'RESERVED';
            IF NEW.state <> 'RESERVED' OR NEW.settlement_id IS NOT NULL OR claim.id IS NULL
              OR claim.redeemed_at IS NOT NULL OR NEW.policy_snapshot IS DISTINCT FROM claim.policy_snapshot
              OR c.redeemed + held >= c.quota OR NOT c.active
              OR clock_timestamp() < c.starts_at OR clock_timestamp() >= c.ends_at THEN
              RAISE EXCEPTION 'Voucher capacity or claim unavailable' USING ERRCODE = '23514'; END IF;
          ELSE
            IF ROW(NEW.id,NEW.created_at,NEW.campaign_id,NEW.claim_id,NEW.customer_id,NEW.scope_id,NEW.attempt_id,
              NEW.reserved_at,NEW.expires_at,NEW.policy_snapshot,NEW.checkout_snapshot)
              IS DISTINCT FROM ROW(OLD.id,OLD.created_at,OLD.campaign_id,OLD.claim_id,OLD.customer_id,OLD.scope_id,OLD.attempt_id,
              OLD.reserved_at,OLD.expires_at,OLD.policy_snapshot,OLD.checkout_snapshot)
              OR (OLD.state <> 'RESERVED' AND ROW(NEW.state,NEW.settlement_id) IS DISTINCT FROM ROW(OLD.state,OLD.settlement_id)
                AND NOT (OLD.state = 'REDEEMED' AND NEW.state = 'REFUNDED'
                  AND NEW.settlement_id = OLD.settlement_id
                  AND public.voucher_full_refund_verified(OLD.id)))
              THEN RAISE EXCEPTION 'Voucher reservation is immutable or terminal' USING ERRCODE = '23514'; END IF;
          END IF;
        END IF;
        RETURN NEW;
      END $$;

      REVOKE EXECUTE ON FUNCTION public.voucher_funding_append_only() FROM PUBLIC;
      REVOKE EXECUTE ON FUNCTION public.voucher_full_refund_verified(uuid) FROM PUBLIC;
      REVOKE EXECUTE ON FUNCTION public.voucher_guard_write() FROM PUBLIC;
      DO $revoke$ DECLARE api_role text; BEGIN
        FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE EXECUTE ON FUNCTION public.voucher_funding_append_only() FROM %I', api_role);
            EXECUTE format('REVOKE EXECUTE ON FUNCTION public.voucher_full_refund_verified(uuid) FROM %I', api_role);
            EXECUTE format('REVOKE EXECUTE ON FUNCTION public.voucher_guard_write() FROM %I', api_role);
          END IF;
        END LOOP;
      END $revoke$;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DO $$ BEGIN
        RAISE EXCEPTION 'Voucher refund policy is forward-only; use a reviewed forward migration';
      END $$;
    `);
  }
}
