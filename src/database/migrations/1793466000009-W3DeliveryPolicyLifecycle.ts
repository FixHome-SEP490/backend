import { MigrationInterface, QueryRunner } from 'typeorm';

/** Operating configuration only. Does not alter any finance, delivery or W1/W2 gate. */
export class W3DeliveryPolicyLifecycle1793466000009 implements MigrationInterface {
  name = 'W3DeliveryPolicyLifecycle1793466000009';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      LOCK TABLE w3_delivery_policy_versions IN ACCESS EXCLUSIVE MODE;
      ALTER TABLE w3_delivery_policy_versions
        DROP CONSTRAINT uq_w3_delivery_policy_content,
        DROP CONSTRAINT ck_w3_delivery_policy_inert,
        DROP CONSTRAINT ck_w3_delivery_policy_revision,
        ADD COLUMN activation_preview_id uuid,
        ADD CONSTRAINT ck_w3_delivery_policy_operating CHECK (
          policy_id = 'w3-delivery-operating-policy' AND status IN ('DRAFT','ACTIVE','RETIRED')
          AND (status = 'ACTIVE') = (activation_preview_id IS NOT NULL)),
        ADD CONSTRAINT ck_w3_delivery_policy_revision CHECK (content_version >= 1 AND revision >= content_version);
      CREATE UNIQUE INDEX uq_w3_delivery_policy_draft_content ON w3_delivery_policy_versions(policy_id,content_version) WHERE status='DRAFT';
      CREATE UNIQUE INDEX uq_w3_delivery_policy_activation_preview ON w3_delivery_policy_versions(activation_preview_id) WHERE activation_preview_id IS NOT NULL;

      CREATE TABLE w3_delivery_policy_previews (
        id uuid PRIMARY KEY,
        draft_id uuid NOT NULL REFERENCES w3_delivery_policy_versions(id) ON DELETE RESTRICT,
        actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        impact jsonb NOT NULL CHECK (jsonb_typeof(impact)='object' AND octet_length(impact::text)<=262144),
        created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      );
      ALTER TABLE w3_delivery_policy_versions ADD CONSTRAINT fk_w3_policy_activation_preview
        FOREIGN KEY (activation_preview_id) REFERENCES w3_delivery_policy_previews(id) ON DELETE RESTRICT;
      CREATE INDEX ix_w3_policy_previews_draft ON w3_delivery_policy_previews(draft_id);
      CREATE UNIQUE INDEX uq_w3_policy_audit_resource ON audit_logs(resource_type,resource_id)
        WHERE resource_type IN ('w3_delivery_policy','w3_delivery_policy_preview');

      -- Preserve the original guards and their private ACLs for an empty-schema reversal.
      ALTER FUNCTION w3_delivery_policy_insert_guard() RENAME TO w3_delivery_policy_insert_guard_draft_v1;
      ALTER FUNCTION w3_delivery_policy_audit_complete() RENAME TO w3_delivery_policy_audit_complete_draft_v1;
      DROP TRIGGER w3_delivery_policy_insert_guard ON w3_delivery_policy_versions;
      DROP TRIGGER w3_delivery_policy_audit_complete ON w3_delivery_policy_versions;

      CREATE FUNCTION w3_delivery_policy_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE params jsonb; key text; canonical text; expected jsonb;
        previous w3_delivery_policy_versions%ROWTYPE; receipt w3_delivery_policy_previews%ROWTYPE;
      BEGIN
        PERFORM pg_advisory_xact_lock(1793466000,6);
        SELECT * INTO previous FROM w3_delivery_policy_versions ORDER BY revision DESC LIMIT 1 FOR UPDATE;
        IF NEW.revision::bigint IS DISTINCT FROM coalesce(previous.revision::bigint,0)+1 THEN
          RAISE EXCEPTION 'W3 delivery policy revision conflict' USING ERRCODE='23514';
        END IF;
        PERFORM id FROM users WHERE id=NEW.created_by_user_id AND role='admin' AND status='active' AND is_active=true FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'W3 policy requires active Admin' USING ERRCODE='23514'; END IF;
        PERFORM rp.role_id FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id
          WHERE r.code='admin' AND p.code='config:update' FOR SHARE OF rp,r,p;
        IF NOT FOUND THEN RAISE EXCEPTION 'W3 policy requires config:update' USING ERRCODE='23514'; END IF;

        IF previous.id IS NULL THEN
          IF NEW.status <> 'DRAFT' OR NEW.content_version <> 1 THEN
            RAISE EXCEPTION 'W3 initial policy must be DRAFT version one' USING ERRCODE='23514'; END IF;
        ELSIF NEW.status='DRAFT' THEN
          IF previous.status NOT IN ('DRAFT','RETIRED') OR NEW.content_version::bigint <> previous.content_version::bigint+1 THEN
            RAISE EXCEPTION 'Invalid W3 draft content transition' USING ERRCODE='23514'; END IF;
        ELSIF NEW.status IN ('ACTIVE','RETIRED') THEN
          IF NOT ((NEW.status='ACTIVE' AND previous.status='DRAFT') OR
            (NEW.status='RETIRED' AND previous.status IN ('DRAFT','ACTIVE')))
            OR NEW.content_version <> previous.content_version OR NEW.snapshot->'policy' IS DISTINCT FROM previous.snapshot->'policy' THEN
            RAISE EXCEPTION 'W3 status transition must preserve content' USING ERRCODE='23514'; END IF;
        ELSE RAISE EXCEPTION 'Invalid W3 lifecycle status' USING ERRCODE='23514'; END IF;

        IF NEW.status='ACTIVE' THEN
          SELECT * INTO receipt FROM w3_delivery_policy_previews WHERE id=NEW.activation_preview_id FOR SHARE;
          IF receipt.id IS NULL OR receipt.draft_id <> previous.id OR receipt.actor_user_id <> NEW.created_by_user_id THEN
            RAISE EXCEPTION 'W3 activation requires own exact server preview' USING ERRCODE='23514'; END IF;
        ELSIF NEW.activation_preview_id IS NOT NULL THEN
          RAISE EXCEPTION 'W3 activation preview only belongs to ACTIVE transition' USING ERRCODE='23514';
        END IF;

        params := NEW.snapshot #> '{policy,parameters}';
        IF jsonb_typeof(params) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'Invalid W3 parameters' USING ERRCODE='23514'; END IF;
        FOREACH key IN ARRAY ARRAY['feeCeilingVnd','proposalReviewAfterMinutes','courierEvidenceReviewAfterMinutes'] LOOP
          IF jsonb_typeof(params->key) IS DISTINCT FROM 'number' OR (params->>key) !~ '^(0|[1-9][0-9]*)$' THEN
            RAISE EXCEPTION 'W3 parameters require explicit integer values' USING ERRCODE='23514'; END IF;
          IF (params->>key)::numeric > 9007199254740991 THEN
            RAISE EXCEPTION 'W3 parameter exceeds safe integer' USING ERRCODE='23514'; END IF;
        END LOOP;
        canonical := '{"kind":"W3_DELIVERY_OPERATING_POLICY_V1","policyId":"w3-delivery-operating-policy","version":' ||
          NEW.content_version || ',"parameters":{"feeCeilingVnd":' || (params->>'feeCeilingVnd') ||
          ',"proposalReviewAfterMinutes":' || (params->>'proposalReviewAfterMinutes') ||
          ',"courierEvidenceReviewAfterMinutes":' || (params->>'courierEvidenceReviewAfterMinutes') || '}}';
        expected := jsonb_build_object('mode','NON_EXECUTABLE_PREVIEW','financialExecution','BLOCKED',
          'status',NEW.status,'revision',NEW.revision,'policy',canonical::jsonb ||
          jsonb_build_object('fingerprint',encode(sha256(convert_to(canonical,'UTF8')),'hex')));
        IF NEW.snapshot IS DISTINCT FROM expected THEN
          RAISE EXCEPTION 'Invalid W3 operating-only snapshot' USING ERRCODE='23514'; END IF;
        NEW.created_at := transaction_timestamp();
        RETURN NEW;
      END $$;
      CREATE TRIGGER w3_delivery_policy_insert_guard BEFORE INSERT ON w3_delivery_policy_versions
        FOR EACH ROW EXECUTE FUNCTION w3_delivery_policy_insert_guard();

      CREATE FUNCTION w3_delivery_policy_preview_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE head w3_delivery_policy_versions%ROWTYPE;
      BEGIN
        PERFORM pg_advisory_xact_lock(1793466000,6);
        SELECT * INTO head FROM w3_delivery_policy_versions ORDER BY revision DESC LIMIT 1 FOR UPDATE;
        IF head.id IS NULL OR head.id <> NEW.draft_id OR head.status <> 'DRAFT' THEN
          RAISE EXCEPTION 'W3 preview requires current DRAFT' USING ERRCODE='23514'; END IF;
        PERFORM id FROM users WHERE id=NEW.actor_user_id AND role='admin' AND status='active' AND is_active=true FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'W3 preview requires active Admin' USING ERRCODE='23514'; END IF;
        PERFORM rp.role_id FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id
          WHERE r.code='admin' AND p.code='config:update' FOR SHARE OF rp,r,p;
        IF NOT FOUND THEN RAISE EXCEPTION 'W3 preview requires config:update' USING ERRCODE='23514'; END IF;
        IF NEW.impact->>'mode' IS DISTINCT FROM 'NON_EXECUTABLE_PREVIEW' OR
          NEW.impact->>'financialExecution' IS DISTINCT FROM 'BLOCKED' OR
          NEW.impact->'policyRevision' IS DISTINCT FROM to_jsonb(head.revision) OR
          NEW.impact->>'policyStatus' IS DISTINCT FROM 'DRAFT' OR
          jsonb_typeof(NEW.impact->'proposals') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'W3 preview snapshot mismatch' USING ERRCODE='23514'; END IF;
        IF jsonb_array_length(NEW.impact->'proposals') > 100 OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(NEW.impact->'proposals') p WHERE p->'policySnapshot' IS DISTINCT FROM head.snapshot->'policy') THEN
          RAISE EXCEPTION 'W3 preview content mismatch' USING ERRCODE='23514'; END IF;
        NEW.created_at := transaction_timestamp();
        RETURN NEW;
      END $$;
      CREATE TRIGGER w3_delivery_policy_preview_guard BEFORE INSERT ON w3_delivery_policy_previews
        FOR EACH ROW EXECUTE FUNCTION w3_delivery_policy_preview_guard();
      CREATE TRIGGER w3_policy_previews_immutable BEFORE UPDATE OR DELETE ON w3_delivery_policy_previews
        FOR EACH ROW EXECUTE FUNCTION w3_delivery_policy_append_only();
      CREATE TRIGGER w3_policy_previews_no_truncate BEFORE TRUNCATE ON w3_delivery_policy_previews
        FOR EACH STATEMENT EXECUTE FUNCTION w3_delivery_policy_append_only();

      CREATE FUNCTION w3_delivery_policy_audit_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE previous_snapshot jsonb; expected_action text; expected_after jsonb;
      BEGIN
        SELECT snapshot INTO previous_snapshot FROM w3_delivery_policy_versions WHERE revision=NEW.revision-1;
        expected_action := CASE WHEN NEW.status='ACTIVE' THEN 'W3_DELIVERY_POLICY_ACTIVATED'
          WHEN NEW.status='RETIRED' THEN 'W3_DELIVERY_POLICY_RETIRED'
          WHEN previous_snapshot IS NULL OR previous_snapshot->>'status'='RETIRED' THEN 'W3_DELIVERY_POLICY_DRAFT_CREATED'
          ELSE 'W3_DELIVERY_POLICY_DRAFT_REVISED' END;
        expected_after := NEW.snapshot || CASE WHEN NEW.activation_preview_id IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object('activationPreviewId',NEW.activation_preview_id) END;
        IF (SELECT count(*) FROM audit_logs a WHERE a.resource_type='w3_delivery_policy' AND a.resource_id=NEW.id::text
          AND a.actor_user_id=NEW.created_by_user_id AND a.actor_role='admin' AND a.action=expected_action
          AND a.before IS NOT DISTINCT FROM previous_snapshot AND a.after=expected_after
          AND a.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296)) <> 1 THEN
          RAISE EXCEPTION 'W3 policy requires exact transactional audit' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER w3_delivery_policy_audit_complete AFTER INSERT ON w3_delivery_policy_versions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w3_delivery_policy_audit_complete();

      CREATE FUNCTION w3_delivery_policy_preview_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT count(*) FROM audit_logs a WHERE a.resource_type='w3_delivery_policy_preview' AND a.resource_id=NEW.id::text
          AND a.actor_user_id=NEW.actor_user_id AND a.actor_role='admin' AND a.action='W3_DELIVERY_POLICY_PREVIEW_CREATED'
          AND a.before IS NULL AND a.after=jsonb_build_object('draftId',NEW.draft_id,'impact',NEW.impact)
          AND a.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296)) <> 1 THEN
          RAISE EXCEPTION 'W3 preview requires exact transactional audit' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER w3_delivery_policy_preview_complete AFTER INSERT ON w3_delivery_policy_previews
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w3_delivery_policy_preview_complete();

      CREATE FUNCTION w3_policy_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' THEN
          IF EXISTS (SELECT 1 FROM audit_logs WHERE resource_type IN ('w3_delivery_policy','w3_delivery_policy_preview')) THEN
            RAISE EXCEPTION 'W3 policy audit is immutable' USING ERRCODE='23514'; END IF;
          RETURN NULL;
        END IF;
        IF OLD.resource_type IN ('w3_delivery_policy','w3_delivery_policy_preview') OR
          (TG_OP='UPDATE' AND NEW.resource_type IN ('w3_delivery_policy','w3_delivery_policy_preview')) THEN
          RAISE EXCEPTION 'W3 policy audit is immutable' USING ERRCODE='23514'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER w3_policy_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION w3_policy_audit_immutable();
      CREATE TRIGGER w3_policy_audit_no_truncate BEFORE TRUNCATE ON audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION w3_policy_audit_immutable();

      CREATE FUNCTION w3_policy_audit_link_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.resource_type='w3_delivery_policy' THEN
          IF NOT EXISTS (SELECT 1 FROM w3_delivery_policy_versions v WHERE v.id::text=NEW.resource_id
            AND v.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296)) THEN
            RAISE EXCEPTION 'W3 audit requires same-transaction policy' USING ERRCODE='23514'; END IF;
        ELSIF NEW.resource_type='w3_delivery_policy_preview' THEN
          IF NOT EXISTS (SELECT 1 FROM w3_delivery_policy_previews p WHERE p.id::text=NEW.resource_id
            AND p.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296)) THEN
            RAISE EXCEPTION 'W3 audit requires same-transaction preview' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER w3_policy_audit_link_complete AFTER INSERT ON audit_logs
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w3_policy_audit_link_complete();

      ALTER TABLE w3_delivery_policy_previews ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON w3_delivery_policy_previews FROM PUBLIC;
      REVOKE ALL ON FUNCTION w3_delivery_policy_insert_guard(),w3_delivery_policy_audit_complete(),
        w3_delivery_policy_preview_guard(),w3_delivery_policy_preview_complete(),w3_policy_audit_immutable(),w3_policy_audit_link_complete() FROM PUBLIC;
      DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
          EXECUTE format('REVOKE ALL ON w3_delivery_policy_previews FROM %I',r);
          EXECUTE format('REVOKE ALL ON FUNCTION w3_delivery_policy_insert_guard(),w3_delivery_policy_audit_complete(),w3_delivery_policy_preview_guard(),w3_delivery_policy_preview_complete(),w3_policy_audit_immutable(),w3_policy_audit_link_complete() FROM %I',r);
        END IF;
      END LOOP; END $$;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      'LOCK TABLE w3_delivery_policy_versions, w3_delivery_policy_previews IN ACCESS EXCLUSIVE MODE',
    );
    const [row] =
      await q.query(`SELECT EXISTS (SELECT 1 FROM w3_delivery_policy_versions) OR
      EXISTS (SELECT 1 FROM w3_delivery_policy_previews) AS occupied`);
    if (row?.occupied !== false)
      throw new Error('Refusing to discard W3 operating lifecycle history');
    await q.query(`
      DROP TRIGGER w3_policy_audit_immutable ON audit_logs;
      DROP TRIGGER w3_policy_audit_no_truncate ON audit_logs;
      DROP TRIGGER w3_policy_audit_link_complete ON audit_logs;
      DROP INDEX uq_w3_policy_audit_resource;
      DROP TRIGGER w3_delivery_policy_insert_guard ON w3_delivery_policy_versions;
      DROP TRIGGER w3_delivery_policy_audit_complete ON w3_delivery_policy_versions;
      DROP FUNCTION w3_delivery_policy_insert_guard(),w3_delivery_policy_audit_complete();
      ALTER FUNCTION w3_delivery_policy_insert_guard_draft_v1() RENAME TO w3_delivery_policy_insert_guard;
      ALTER FUNCTION w3_delivery_policy_audit_complete_draft_v1() RENAME TO w3_delivery_policy_audit_complete;
      ALTER TABLE w3_delivery_policy_versions DROP CONSTRAINT fk_w3_policy_activation_preview,
        DROP CONSTRAINT ck_w3_delivery_policy_operating, DROP CONSTRAINT ck_w3_delivery_policy_revision,
        DROP COLUMN activation_preview_id;
      DROP INDEX uq_w3_delivery_policy_draft_content;
      DROP TABLE w3_delivery_policy_previews;
      DROP FUNCTION w3_delivery_policy_preview_guard(),w3_delivery_policy_preview_complete(),w3_policy_audit_immutable(),w3_policy_audit_link_complete();
      ALTER TABLE w3_delivery_policy_versions
        ADD CONSTRAINT uq_w3_delivery_policy_content UNIQUE(policy_id,content_version),
        ADD CONSTRAINT ck_w3_delivery_policy_inert CHECK(policy_id='w3-delivery-operating-policy' AND status='DRAFT'),
        ADD CONSTRAINT ck_w3_delivery_policy_revision CHECK(revision>=1 AND content_version=revision);
      CREATE TRIGGER w3_delivery_policy_insert_guard BEFORE INSERT ON w3_delivery_policy_versions
        FOR EACH ROW EXECUTE FUNCTION w3_delivery_policy_insert_guard();
      CREATE CONSTRAINT TRIGGER w3_delivery_policy_audit_complete AFTER INSERT ON w3_delivery_policy_versions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w3_delivery_policy_audit_complete();
    `);
  }
}
