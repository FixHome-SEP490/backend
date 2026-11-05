import { MigrationInterface, QueryRunner } from 'typeorm';

/** SOURCE ONLY. DRAFT history, never an effective policy or financial cutover. */
export class W3DeliveryOperatingPolicy1793466000006 implements MigrationInterface {
  name = 'W3DeliveryOperatingPolicy1793466000006';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE w3_delivery_policy_versions (
        id uuid PRIMARY KEY,
        policy_id varchar(64) NOT NULL,
        content_version integer NOT NULL,
        revision integer NOT NULL,
        status varchar(16) NOT NULL,
        snapshot jsonb NOT NULL,
        created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT uq_w3_delivery_policy_revision UNIQUE (policy_id, revision),
        CONSTRAINT uq_w3_delivery_policy_content UNIQUE (policy_id, content_version),
        CONSTRAINT ck_w3_delivery_policy_inert CHECK (policy_id = 'w3-delivery-operating-policy' AND status = 'DRAFT'),
        CONSTRAINT ck_w3_delivery_policy_revision CHECK (revision >= 1 AND content_version = revision),
        CONSTRAINT ck_w3_delivery_policy_snapshot CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 4096)
      );

      CREATE FUNCTION w3_delivery_policy_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'W3 delivery policy history is immutable' USING ERRCODE = '23514';
      END $$;
      CREATE TRIGGER w3_delivery_policy_immutable BEFORE UPDATE OR DELETE ON w3_delivery_policy_versions
        FOR EACH ROW EXECUTE FUNCTION w3_delivery_policy_append_only();
      CREATE TRIGGER w3_delivery_policy_no_truncate BEFORE TRUNCATE ON w3_delivery_policy_versions
        FOR EACH STATEMENT EXECUTE FUNCTION w3_delivery_policy_append_only();

      CREATE FUNCTION w3_delivery_policy_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE params jsonb; key text; canonical text; expected jsonb; previous_revision bigint;
      BEGIN
        -- Same lock as the service, scoped to the transaction across all backend instances.
        PERFORM pg_advisory_xact_lock(1793466000, 6);
        SELECT max(revision) INTO previous_revision FROM w3_delivery_policy_versions;
        IF NEW.revision::bigint IS DISTINCT FROM coalesce(previous_revision, 0) + 1 THEN
          RAISE EXCEPTION 'W3 delivery policy revision conflict' USING ERRCODE = '23514';
        END IF;
        PERFORM id FROM users WHERE id = NEW.created_by_user_id AND role = 'admin'
          AND status = 'active' AND is_active = true FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'W3 policy requires active Admin' USING ERRCODE = '23514'; END IF;
        PERFORM rp.role_id FROM role_permissions rp INNER JOIN roles r ON r.id = rp.role_id
          INNER JOIN permissions p ON p.id = rp.permission_id
          WHERE r.code = 'admin' AND p.code = 'config:update' FOR SHARE OF rp, r, p;
        IF NOT FOUND THEN RAISE EXCEPTION 'W3 policy requires config:update' USING ERRCODE = '23514'; END IF;
        params := NEW.snapshot #> '{policy,parameters}';
        IF jsonb_typeof(params) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'Invalid W3 parameters' USING ERRCODE = '23514';
        END IF;
        FOREACH key IN ARRAY ARRAY['feeCeilingVnd','proposalReviewAfterMinutes','courierEvidenceReviewAfterMinutes'] LOOP
          IF jsonb_typeof(params->key) IS DISTINCT FROM 'number' OR
            (params->>key) !~ '^(0|[1-9][0-9]*)$' THEN
            RAISE EXCEPTION 'W3 parameters require explicit integer values' USING ERRCODE = '23514';
          END IF;
          IF (params->>key)::numeric > 9007199254740991 THEN
            RAISE EXCEPTION 'W3 parameter exceeds safe integer' USING ERRCODE = '23514';
          END IF;
        END LOOP;
        -- Canonical key order matches the pure domain JSON.stringify, independent of JSONB order.
        canonical := '{"kind":"W3_DELIVERY_OPERATING_POLICY_V1","policyId":"w3-delivery-operating-policy","version":' ||
          NEW.content_version || ',"parameters":{"feeCeilingVnd":' || (params->>'feeCeilingVnd') ||
          ',"proposalReviewAfterMinutes":' || (params->>'proposalReviewAfterMinutes') ||
          ',"courierEvidenceReviewAfterMinutes":' || (params->>'courierEvidenceReviewAfterMinutes') || '}}';
        expected := jsonb_build_object('mode','NON_EXECUTABLE_PREVIEW','financialExecution','BLOCKED',
          'status','DRAFT','revision',NEW.revision,'policy', canonical::jsonb ||
          jsonb_build_object('fingerprint',encode(sha256(convert_to(canonical,'UTF8')),'hex')));
        IF NEW.snapshot IS DISTINCT FROM expected THEN
          RAISE EXCEPTION 'Invalid or non-inert W3 policy snapshot' USING ERRCODE = '23514';
        END IF;
        NEW.created_at := transaction_timestamp();
        RETURN NEW;
      END $$;
      CREATE TRIGGER w3_delivery_policy_insert_guard BEFORE INSERT ON w3_delivery_policy_versions
        FOR EACH ROW EXECUTE FUNCTION w3_delivery_policy_insert_guard();

      CREATE FUNCTION w3_delivery_policy_audit_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE previous_snapshot jsonb;
      BEGIN
        SELECT snapshot INTO previous_snapshot FROM w3_delivery_policy_versions WHERE revision = NEW.revision - 1;
        IF NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.resource_type = 'w3_delivery_policy'
          AND a.resource_id = NEW.id::text AND a.actor_user_id = NEW.created_by_user_id AND a.actor_role = 'admin'
          AND a.action = CASE WHEN NEW.revision = 1 THEN 'W3_DELIVERY_POLICY_DRAFT_CREATED' ELSE 'W3_DELIVERY_POLICY_DRAFT_REVISED' END
          AND a.before IS NOT DISTINCT FROM previous_snapshot AND a.after = NEW.snapshot) THEN
          RAISE EXCEPTION 'W3 policy requires exact transactional audit' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER w3_delivery_policy_audit_complete AFTER INSERT ON w3_delivery_policy_versions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w3_delivery_policy_audit_complete();

      ALTER TABLE w3_delivery_policy_versions ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON w3_delivery_policy_versions FROM PUBLIC;
      REVOKE ALL ON FUNCTION w3_delivery_policy_append_only(), w3_delivery_policy_insert_guard(), w3_delivery_policy_audit_complete() FROM PUBLIC;
      DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE ALL ON w3_delivery_policy_versions FROM %I', r);
          EXECUTE format('REVOKE ALL ON FUNCTION w3_delivery_policy_append_only(), w3_delivery_policy_insert_guard(), w3_delivery_policy_audit_complete() FROM %I', r);
        END IF;
      END LOOP; END $$;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    // Empty-schema reversal only. Never discard a saved revision or its audit history.
    await q.query(
      `LOCK TABLE w3_delivery_policy_versions IN ACCESS EXCLUSIVE MODE`,
    );
    const rows = await q.query(
      `SELECT EXISTS (SELECT 1 FROM w3_delivery_policy_versions) AS occupied`,
    );
    if (rows[0]?.occupied !== false)
      throw new Error('Refusing to discard W3 delivery policy history');
    await q.query(`DROP TABLE w3_delivery_policy_versions;
      DROP FUNCTION w3_delivery_policy_audit_complete();
      DROP FUNCTION w3_delivery_policy_insert_guard();
      DROP FUNCTION w3_delivery_policy_append_only();`);
  }
}
