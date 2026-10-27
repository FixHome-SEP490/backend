import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive voucher schema only. No existing rows, auth policies or money tables are changed.
 * Application registration, authoritative adapters and MONEY activation remain separate gates. */
export class VoucherCore1792994400000 implements MigrationInterface {
  name = 'VoucherCore1792994400000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE FUNCTION voucher_policy_valid(p jsonb) RETURNS boolean
      LANGUAGE plpgsql IMMUTABLE STRICT AS $$
      DECLARE list jsonb; entry jsonb; field text;
      BEGIN
        IF jsonb_typeof(p) IS DISTINCT FROM 'object'
          OR NOT (p ?& ARRAY['discount','value','capVnd','minimumVnd','categoryIds','serviceIds','components'])
          OR jsonb_typeof(p->'discount') IS DISTINCT FROM 'string'
          OR p->>'discount' NOT IN ('PERCENT','FIXED')
          OR p->'components' IS DISTINCT FROM '["LABOR","PARTS"]'::jsonb THEN RETURN false; END IF;
        FOREACH field IN ARRAY ARRAY['value','minimumVnd'] LOOP
          IF jsonb_typeof(p->field) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
          IF (p->>field)::numeric <> trunc((p->>field)::numeric)
            OR (p->>field)::numeric < 0 OR (p->>field)::numeric > 2147483647 THEN RETURN false; END IF;
        END LOOP;
        IF (p->>'value')::numeric < 1
          OR (p->>'discount' = 'PERCENT' AND (p->>'value')::numeric > 100) THEN RETURN false; END IF;
        IF p->'capVnd' IS DISTINCT FROM 'null'::jsonb THEN
          IF jsonb_typeof(p->'capVnd') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
          IF (p->>'capVnd')::numeric <> trunc((p->>'capVnd')::numeric)
            OR (p->>'capVnd')::numeric < 1 OR (p->>'capVnd')::numeric > 2147483647 THEN RETURN false; END IF;
        END IF;
        FOREACH field IN ARRAY ARRAY['categoryIds','serviceIds'] LOOP
          list := p->field;
          IF jsonb_typeof(list) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
          IF jsonb_array_length(list) > 100 THEN RETURN false; END IF;
          FOR entry IN SELECT value FROM jsonb_array_elements(list) LOOP
            IF jsonb_typeof(entry) IS DISTINCT FROM 'string'
              OR (entry #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              THEN RETURN false; END IF;
          END LOOP;
          IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(list)) <> jsonb_array_length(list)
            THEN RETURN false; END IF;
        END LOOP;
        RETURN true;
      END $$;

      CREATE TABLE voucher_campaigns (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        code varchar(40) NOT NULL CHECK (code ~ '^[A-Z0-9_-]{3,40}$'),
        name varchar(120) NOT NULL CHECK (length(btrim(name)) > 0),
        kind varchar(16) NOT NULL CHECK (kind IN ('GENERAL','PERSONAL')),
        policy jsonb NOT NULL CHECK (voucher_policy_valid(policy)),
        starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
        active boolean NOT NULL DEFAULT true, quota integer NOT NULL CHECK (quota > 0),
        auto_compensation boolean NOT NULL DEFAULT false,
        redeemed integer NOT NULL DEFAULT 0 CHECK (redeemed BETWEEN 0 AND quota),
        CONSTRAINT ck_voucher_campaign_time CHECK (ends_at > starts_at),
        CONSTRAINT ck_voucher_auto_compensation_kind CHECK (NOT auto_compensation OR kind = 'PERSONAL')
      );
      CREATE UNIQUE INDEX uq_voucher_campaign_code ON voucher_campaigns(code);
      CREATE UNIQUE INDEX uq_voucher_campaign_kind ON voucher_campaigns(id,kind);
      CREATE UNIQUE INDEX uq_voucher_active_auto_compensation ON voucher_campaigns(auto_compensation) WHERE auto_compensation AND active;

      CREATE TABLE voucher_claims (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        campaign_id uuid NOT NULL, campaign_kind varchar(16) NOT NULL,
        customer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        source_kind varchar(16), source_id uuid, source_key varchar(64),
        policy_snapshot jsonb NOT NULL CHECK (voucher_policy_valid(policy_snapshot)),
        redeemed_at timestamptz,
        CONSTRAINT fk_voucher_claim_campaign FOREIGN KEY (campaign_id,campaign_kind)
          REFERENCES voucher_campaigns(id,kind) ON DELETE RESTRICT,
        CONSTRAINT ck_voucher_claim_source CHECK (
          (campaign_kind = 'GENERAL' AND source_kind IS NULL AND source_id IS NULL AND source_key IS NULL)
          OR (campaign_kind = 'PERSONAL' AND source_kind IS NOT NULL AND source_id IS NOT NULL
            AND source_key IS NOT NULL AND source_kind IN ('VISIT_GROUP','SOLO','ADMIN_GRANT')
            AND source_key = source_kind || ':' || source_id::text)
        )
      );
      CREATE UNIQUE INDEX uq_voucher_claim_customer ON voucher_claims(campaign_id,customer_id) WHERE source_key IS NULL;
      CREATE UNIQUE INDEX uq_voucher_compensation_source ON voucher_claims(source_kind,source_id) WHERE source_id IS NOT NULL;
      CREATE UNIQUE INDEX uq_voucher_claim_identity ON voucher_claims(id,campaign_id,customer_id);
      CREATE INDEX idx_voucher_wallet ON voucher_claims(customer_id,created_at);

      CREATE TABLE voucher_reservations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        campaign_id uuid NOT NULL REFERENCES voucher_campaigns(id) ON DELETE RESTRICT,
        claim_id uuid NOT NULL, customer_id uuid NOT NULL, scope_id uuid NOT NULL, attempt_id uuid NOT NULL,
        state varchar(16) NOT NULL CHECK (state IN ('RESERVED','RELEASED','EXPIRED','REDEEMED')),
        reserved_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
        policy_snapshot jsonb NOT NULL CHECK (voucher_policy_valid(policy_snapshot)),
        checkout_snapshot jsonb NOT NULL, settlement_id uuid,
        CONSTRAINT fk_voucher_reservation_claim FOREIGN KEY (claim_id,campaign_id,customer_id)
          REFERENCES voucher_claims(id,campaign_id,customer_id) ON DELETE RESTRICT,
        CONSTRAINT ck_voucher_reservation_ttl CHECK (expires_at = reserved_at + interval '15 minutes'),
        CONSTRAINT ck_voucher_reservation_settlement CHECK ((state = 'REDEEMED') = (settlement_id IS NOT NULL)),
        CONSTRAINT ck_voucher_checkout_identity CHECK ((jsonb_typeof(checkout_snapshot) = 'object'
          AND checkout_snapshot->>'customerId' = customer_id::text
          AND checkout_snapshot->>'scopeId' = scope_id::text
          AND checkout_snapshot->'finalized' = 'true'::jsonb
          AND checkout_snapshot->>'paymentState' = 'NOT_STARTED'
          AND checkout_snapshot->>'snapshotId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS TRUE)
      );
      CREATE UNIQUE INDEX uq_voucher_attempt ON voucher_reservations(customer_id,attempt_id);
      CREATE UNIQUE INDEX uq_voucher_live_claim ON voucher_reservations(claim_id) WHERE state IN ('RESERVED','REDEEMED');
      CREATE UNIQUE INDEX uq_voucher_live_scope ON voucher_reservations(scope_id) WHERE state IN ('RESERVED','REDEEMED');
      CREATE UNIQUE INDEX uq_voucher_settlement ON voucher_reservations(settlement_id) WHERE settlement_id IS NOT NULL;
      CREATE INDEX idx_voucher_reservation_expiry ON voucher_reservations(campaign_id,state,expires_at);

      CREATE TABLE voucher_audit (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        actor_id uuid REFERENCES users(id) ON DELETE RESTRICT, action varchar(32) NOT NULL,
        resource_id uuid NOT NULL, snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object')
      );
    `);
    await runner.query(`
      CREATE FUNCTION voucher_guard_write() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE c voucher_campaigns%ROWTYPE; claim voucher_claims%ROWTYPE; held bigint;
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
            SELECT * INTO c FROM voucher_campaigns WHERE id = NEW.campaign_id FOR UPDATE;
            IF NOT FOUND OR NEW.policy_snapshot IS DISTINCT FROM c.policy OR NEW.redeemed_at IS NOT NULL
              OR NOT c.active OR clock_timestamp() < c.starts_at OR clock_timestamp() >= c.ends_at THEN
              RAISE EXCEPTION 'Invalid voucher claim snapshot' USING ERRCODE = '23514'; END IF;
          ELSE
            IF ROW(NEW.id,NEW.created_at,NEW.campaign_id,NEW.campaign_kind,NEW.customer_id,NEW.source_kind,NEW.source_id,NEW.source_key,NEW.policy_snapshot)
              IS DISTINCT FROM ROW(OLD.id,OLD.created_at,OLD.campaign_id,OLD.campaign_kind,OLD.customer_id,OLD.source_kind,OLD.source_id,OLD.source_key,OLD.policy_snapshot)
              OR (OLD.redeemed_at IS NOT NULL AND NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at)
              THEN RAISE EXCEPTION 'Voucher claim identity is immutable' USING ERRCODE = '23514'; END IF;
          END IF;
        ELSIF TG_TABLE_NAME = 'voucher_reservations' THEN
          SELECT * INTO c FROM voucher_campaigns WHERE id = NEW.campaign_id FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'Unknown voucher campaign' USING ERRCODE = '23514'; END IF;
          IF TG_OP = 'INSERT' THEN
            SELECT * INTO claim FROM voucher_claims WHERE id = NEW.claim_id;
            SELECT count(*) INTO held FROM voucher_reservations WHERE campaign_id = c.id AND state = 'RESERVED';
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
              OR (OLD.state <> 'RESERVED' AND ROW(NEW.state,NEW.settlement_id) IS DISTINCT FROM ROW(OLD.state,OLD.settlement_id))
              THEN RAISE EXCEPTION 'Voucher reservation is immutable or terminal' USING ERRCODE = '23514'; END IF;
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER voucher_campaign_immutable BEFORE UPDATE OR DELETE ON voucher_campaigns FOR EACH ROW EXECUTE FUNCTION voucher_guard_write();
      CREATE TRIGGER voucher_claim_immutable BEFORE INSERT OR UPDATE OR DELETE ON voucher_claims FOR EACH ROW EXECUTE FUNCTION voucher_guard_write();
      CREATE TRIGGER voucher_reservation_immutable BEFORE INSERT OR UPDATE OR DELETE ON voucher_reservations FOR EACH ROW EXECUTE FUNCTION voucher_guard_write();
      CREATE TRIGGER voucher_audit_immutable BEFORE UPDATE OR DELETE ON voucher_audit FOR EACH ROW EXECUTE FUNCTION voucher_guard_write();

      -- Deferred checks see the final transaction state after claim/counter/reservation writes.
      -- No expiry predicate uses now() in an index. Overdue unverified holds still occupy capacity.
      CREATE FUNCTION voucher_check_usage() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE cid uuid; paid integer; limit_count integer; actual_paid bigint; held bigint;
      BEGIN
        IF TG_TABLE_NAME = 'voucher_campaigns' THEN cid := NEW.id; ELSE cid := NEW.campaign_id; END IF;
        SELECT redeemed,quota INTO paid,limit_count FROM voucher_campaigns WHERE id = cid FOR UPDATE;
        SELECT count(*) FILTER (WHERE state = 'REDEEMED'), count(*) FILTER (WHERE state = 'RESERVED')
          INTO actual_paid,held FROM voucher_reservations WHERE campaign_id = cid;
        IF paid <> actual_paid OR paid + held > limit_count THEN
          RAISE EXCEPTION 'Voucher quota invariant violated' USING ERRCODE = '23514'; END IF;
        IF EXISTS (SELECT 1 FROM voucher_claims claim WHERE claim.campaign_id = cid AND
          (claim.redeemed_at IS NOT NULL) IS DISTINCT FROM EXISTS
          (SELECT 1 FROM voucher_reservations r WHERE r.claim_id = claim.id AND r.state = 'REDEEMED')) THEN
          RAISE EXCEPTION 'Voucher claim redemption invariant violated' USING ERRCODE = '23514'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER voucher_campaign_usage AFTER INSERT OR UPDATE ON voucher_campaigns
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION voucher_check_usage();
      CREATE CONSTRAINT TRIGGER voucher_reservation_usage AFTER INSERT OR UPDATE ON voucher_reservations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION voucher_check_usage();
      CREATE CONSTRAINT TRIGGER voucher_claim_usage AFTER INSERT OR UPDATE ON voucher_claims
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION voucher_check_usage();
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Only an empty voucher schema may be removed. Historical data requires forward repair.
    await runner.query(`
      LOCK TABLE voucher_campaigns,voucher_claims,voucher_reservations,voucher_audit IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM voucher_campaigns) OR EXISTS (SELECT 1 FROM voucher_claims)
          OR EXISTS (SELECT 1 FROM voucher_reservations) OR EXISTS (SELECT 1 FROM voucher_audit) THEN
          RAISE EXCEPTION 'Voucher history exists; use a reviewed forward migration';
        END IF;
      END $$;
      DROP TABLE voucher_reservations;
      DROP TABLE voucher_claims;
      DROP TABLE voucher_audit;
      DROP TABLE voucher_campaigns;
      DROP FUNCTION voucher_check_usage();
      DROP FUNCTION voucher_guard_write();
      DROP FUNCTION voucher_policy_valid(jsonb);
    `);
  }
}
