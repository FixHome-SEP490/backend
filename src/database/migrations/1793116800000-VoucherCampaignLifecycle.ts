import { MigrationInterface, QueryRunner } from 'typeorm';

/** Forward only. Run after VoucherCore and VoucherFundingLedger under the owner release gate.
 * Does not rewrite claims, reservations, funding/refund ledgers or the generic voucher guard. */
export class VoucherCampaignLifecycle1793116800000 implements MigrationInterface {
  name = 'VoucherCampaignLifecycle1793116800000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      LOCK TABLE public.voucher_campaigns IN ACCESS EXCLUSIVE MODE;
      ALTER TABLE public.voucher_campaigns
        ADD COLUMN status varchar(16),
        ADD COLUMN version integer NOT NULL DEFAULT 1,
        ADD COLUMN published_at timestamptz;

      -- Every old campaign was already published, including inactive campaigns with zero claims.
      UPDATE public.voucher_campaigns
        SET status = CASE WHEN active THEN 'PUBLISHED' ELSE 'PAUSED' END,
            published_at = created_at;

      -- Core's deferred voucher_campaign_usage constraint trigger queued by the
      -- backfill must be checked before the next ALTER TABLE. PostgreSQL rejects
      -- DDL on a relation with pending trigger events in this transaction.
      SET CONSTRAINTS ALL IMMEDIATE;

      ALTER TABLE public.voucher_campaigns
        ALTER COLUMN status SET NOT NULL,
        ALTER COLUMN status SET DEFAULT 'DRAFT',
        ALTER COLUMN active SET DEFAULT false,
        ADD CONSTRAINT ck_voucher_campaign_lifecycle CHECK (
          status IN ('DRAFT','PUBLISHED','PAUSED','ARCHIVED')
          AND active = (status = 'PUBLISHED')
          AND (status <> 'DRAFT' OR (published_at IS NULL AND redeemed = 0))
          AND (status NOT IN ('PUBLISHED','PAUSED') OR published_at IS NOT NULL)
        ),
        ADD CONSTRAINT ck_voucher_campaign_version CHECK (version > 0);

      CREATE FUNCTION public.voucher_campaign_guard_write() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
      DECLARE terms_changed boolean; lifecycle_changed boolean; history_exists boolean;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Voucher history cannot be deleted' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF NEW.status IS DISTINCT FROM 'DRAFT' OR NEW.published_at IS NOT NULL
            OR NEW.active OR NEW.redeemed <> 0 OR NEW.version <> 1 THEN
            RAISE EXCEPTION 'New campaign must be an unpublished draft' USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.created_at) THEN
          RAISE EXCEPTION 'Voucher campaign identity is immutable' USING ERRCODE = '23514';
        END IF;
        terms_changed := ROW(NEW.code,NEW.name,NEW.kind,NEW.policy,NEW.starts_at,NEW.ends_at,NEW.quota,NEW.auto_compensation)
          IS DISTINCT FROM ROW(OLD.code,OLD.name,OLD.kind,OLD.policy,OLD.starts_at,OLD.ends_at,OLD.quota,OLD.auto_compensation);
        lifecycle_changed := ROW(NEW.status,NEW.active,NEW.published_at)
          IS DISTINCT FROM ROW(OLD.status,OLD.active,OLD.published_at);

        IF OLD.status = 'DRAFT' THEN
          SELECT EXISTS (SELECT 1 FROM public.voucher_claims WHERE campaign_id = OLD.id)
            OR EXISTS (SELECT 1 FROM public.voucher_reservations WHERE campaign_id = OLD.id)
            INTO history_exists;
          IF OLD.published_at IS NOT NULL OR OLD.active OR OLD.redeemed <> 0 OR history_exists THEN
            RAISE EXCEPTION 'Draft has publication or booking history' USING ERRCODE = '23514';
          END IF;
        END IF;
        IF terms_changed AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'DRAFT'
          AND OLD.published_at IS NULL AND NEW.published_at IS NULL AND NOT history_exists) THEN
          RAISE EXCEPTION 'Published voucher campaign conditions are immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
          (OLD.status = 'DRAFT' AND NEW.status IN ('PUBLISHED','ARCHIVED'))
          OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('PAUSED','ARCHIVED'))
          OR (OLD.status = 'PAUSED' AND NEW.status IN ('PUBLISHED','ARCHIVED'))
        ) THEN
          RAISE EXCEPTION 'Invalid voucher campaign transition' USING ERRCODE = '23514';
        END IF;
        IF NOT (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED')
          AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'Publication provenance is immutable' USING ERRCODE = '23514';
        END IF;
        IF terms_changed OR lifecycle_changed OR NEW.version <> OLD.version THEN
          IF NEW.version::bigint <> OLD.version::bigint + 1 OR NEW.redeemed <> OLD.redeemed
            OR (NOT terms_changed AND NOT lifecycle_changed AND OLD.status <> 'DRAFT') THEN
            RAISE EXCEPTION 'Stale voucher campaign version' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END $$;

      -- Only replace the campaign trigger. Claims/reservations retain the F4/F3 generic guard.
      DROP TRIGGER voucher_campaign_immutable ON public.voucher_campaigns;
      CREATE TRIGGER voucher_campaign_immutable BEFORE INSERT OR UPDATE OR DELETE
        ON public.voucher_campaigns FOR EACH ROW EXECUTE FUNCTION public.voucher_campaign_guard_write();

      CREATE UNIQUE INDEX uq_voucher_campaign_command
        ON public.voucher_audit ((snapshot->>'commandId'))
        WHERE action IN ('CREATE_CAMPAIGN','EDIT_CAMPAIGN','CAMPAIGN_LIFECYCLE') AND snapshot ? 'commandId';

      ALTER TABLE public.voucher_campaigns ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.voucher_campaigns FROM PUBLIC;
      REVOKE EXECUTE ON FUNCTION public.voucher_campaign_guard_write() FROM PUBLIC;
      DO $revoke$ DECLARE api_role text; BEGIN
        FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON public.voucher_campaigns FROM %I', api_role);
            EXECUTE format('REVOKE EXECUTE ON FUNCTION public.voucher_campaign_guard_write() FROM %I', api_role);
          END IF;
        END LOOP;
      END $revoke$;
      -- No new backend grants or permissive RLS policy. The owner must verify the real app role.
    `);
  }

  async down(_runner: QueryRunner): Promise<void> {
    throw new Error('Campaign lifecycle requires a reviewed forward migration; publication provenance must be preserved');
  }
}
