// Existing ephemeral PostgreSQL CI service ONLY. No dotenv, DATABASE_* or shared DB option.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { Role } from '../../shared/enums';
import { reviseW3DeliveryPolicyDraft } from './w3-delivery-policy';
import type { W3DeliveryPolicyService } from './w3-delivery-policy-admin.service';
import { W3DeliveryOperatingPolicy1793466000006 } from '../../database/migrations/1793466000006-W3DeliveryOperatingPolicy';
import { W3DeliveryPolicyLifecycle1793466000009 } from '../../database/migrations/1793466000009-W3DeliveryPolicyLifecycle';
import { previewW3DeliveryPolicyImpact } from './w3-delivery-policy-preview';

describe.skipIf(
  process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true',
)(
  'B3a isolated CI PostgreSQL DRAFT policy (no HTTP/financial execution)',
  () => {
    const schema = `w3_policy_e2e_${randomUUID().replaceAll('-', '')}`;
    let root: DataSource,
      db: DataSource,
      service: W3DeliveryPolicyService,
      actor: { id: string; role: Role };
    const parameters = {
      feeCeilingVnd: 50000,
      proposalReviewAfterMinutes: 30,
      courierEvidenceReviewAfterMinutes: 60,
    };
    const request = (expectedRevision: number) => ({
      expectedRevision,
      parameters,
    });
    beforeAll(async () => {
      const connection = {
        type: 'postgres' as const,
        host: '127.0.0.1',
        port: 5432,
        username: 'postgres',
        password: 'postgres',
        database: 'fixhome',
        ssl: false,
        synchronize: false,
      };
      root = await new DataSource(connection).initialize();
      if (
        (await root.query('SELECT current_database() AS name'))[0].name !==
          'fixhome' ||
        !/^w3_policy_e2e_[a-f0-9]{32}$/.test(schema)
      )
        throw new Error('Wrong CI fixture');
      await root.query(
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public',
      );
      await root.query(`CREATE SCHEMA "${schema}"`);
      db = await new DataSource({
        ...connection,
        schema,
        extra: {
          options: `-c search_path=${schema},public -c lock_timeout=5000 -c statement_timeout=15000`,
        },
        entities: [resolve('dist/**/*.entity.js')],
        migrations: [resolve('dist/database/migrations/*.js')],
      }).initialize();
      // Same private-schema exclusions as the existing B1 PostgreSQL harness.
      db.migrations.splice(
        0,
        db.migrations.length,
        ...db.migrations.filter(
          (m) =>
            ![
              'VoucherFundingLedger1792994400001',
              'VoucherCampaignLifecycle1793116800000',
              'CashPaymentIntents1793293200000',
              'TechnicianResponsibility1793293200001',
            ].includes(m.name),
        ),
      );
      await db.runMigrations();
      const save = (name: string, row: object) =>
        db.getRepository(name).save(row);
      const role = await save('RoleEntity', {
        code: Role.ADMIN,
        name: 'CI Admin',
      });
      for (const action of ['read', 'update']) {
        const permission = await save('Permission', {
          code: `config:${action}`,
          resource: 'config',
          action,
        });
        await save('RolePermission', {
          roleId: role.id,
          permissionId: permission.id,
        });
      }
      const user = await save('User', {
        email: `${randomUUID()}@example.test`,
        fullName: 'B3a synthetic Admin',
        // CI-only placeholder satisfies the real users credential CHECK; never used to sign in.
        passwordHash: 'CI_FIXTURE_NOT_A_REAL_PASSWORD_HASH',
        role: Role.ADMIN,
        status: 'active',
        isActive: true,
      });
      actor = { id: user.id, role: Role.ADMIN };
      // Match compiled entity identities, as in the existing B1 harness.
      const runtime = createRequire(resolve('package.json'));
      const Audit = runtime(
        resolve('dist/modules/audit-log/audit-log.service.js'),
      ).AuditLogService;
      const Store = runtime(
        resolve(
          'dist/modules/system-config/w3-delivery-policy-store.service.js',
        ),
      ).W3DeliveryPolicyStore;
      const Service = runtime(
        resolve(
          'dist/modules/system-config/w3-delivery-policy-admin.service.js',
        ),
      ).W3DeliveryPolicyService;
      service = new Service(
        db,
        new Store(new Audit(db.getRepository('AuditLog'))),
      );
    }, 60000);
    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (root?.isInitialized) {
        if (!/^w3_policy_e2e_[a-f0-9]{32}$/.test(schema))
          throw new Error('Unsafe fixture cleanup');
        await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await root.destroy();
      }
    });

    const current = async () => (await service.current(actor)).draft;
    const count = () => db.getRepository('W3DeliveryPolicyVersion').count();
    it('starts empty, races initial create, and commits one DRAFT plus audit', async () => {
      expect(await current()).toBeNull();
      const results = await Promise.allSettled([
        service.create(request(0), actor),
        service.create(request(0), actor),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toMatchObject([
        { reason: { status: 409 } },
      ]);
      expect(await count()).toBe(1);
      expect(
        await db
          .getRepository('AuditLog')
          .count({ where: { resourceType: 'w3_delivery_policy' } }),
      ).toBe(1);
    });
    it('serializes concurrent PATCH and refuses stale/replayed versions', async () => {
      const head = await current();
      const results = await Promise.allSettled([
        service.revise(head.id, request(head.state.revision), actor),
        service.revise(head.id, request(head.state.revision), actor),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toMatchObject([
        { reason: { status: 409 } },
      ]);
      await expect(
        service.revise(head.id, request(head.state.revision), actor),
      ).rejects.toMatchObject({ status: 409 });
      const history = await service.history({}, actor);
      expect(history.drafts.at(-1).state).toEqual(head.state);
    });
    it('previews a persisted historical snapshot without financial changes', async () => {
      const history = await service.history({}, actor);
      const historical = history.drafts.at(-1),
        before = await count();
      const preview = await service.preview(
        {
          draftId: historical.id,
          expectedRevision: historical.state.revision,
          samples: [],
        },
        actor,
      );
      expect(preview.financialExecution).toBe('BLOCKED');
      expect(preview.blockers).toContain('FINANCE_CUTOVER_CLOSED');
      expect(preview.hypotheticalOnly).toBe(true);
      expect(await count()).toBe(before);
    });
    it.each([
      'UPDATE w3_delivery_policy_versions SET status = status',
      'DELETE FROM w3_delivery_policy_versions',
      'TRUNCATE w3_delivery_policy_versions',
    ])('rejects history mutation: %s', async (sql) => {
      const before = await count();
      await expect(db.query(sql)).rejects.toThrow();
      expect(await count()).toBe(before);
    });

    async function direct(
      mutate: (row: any) => void,
      audit: 'exact' | 'missing' | 'wrong-before' = 'exact',
    ) {
      const head = await current();
      const snapshot = reviseW3DeliveryPolicyDraft(
        head.state,
        parameters,
        head.state.revision,
      );
      const row = {
        id: randomUUID(),
        policyId: snapshot.policy.policyId,
        contentVersion: snapshot.policy.version,
        revision: snapshot.revision,
        status: 'DRAFT',
        snapshot,
        createdByUserId: actor.id,
      };
      // Serialized copies permit explicit adversarial mutation without touching pure frozen state.
      const changed = JSON.parse(JSON.stringify(row));
      mutate(changed);
      return db.transaction(async (manager) => {
        await manager.insert('W3DeliveryPolicyVersion', changed);
        if (audit !== 'missing')
          await manager.insert('AuditLog', {
            actorUserId: actor.id,
            actorRole: Role.ADMIN,
            action: 'W3_DELIVERY_POLICY_DRAFT_REVISED',
            resourceType: 'w3_delivery_policy',
            resourceId: changed.id,
            before: audit === 'wrong-before' ? null : head.state,
            after: changed.snapshot,
          });
      });
    }
    it.each([
      [
        'ACTIVE',
        (r: any) => {
          r.status = 'ACTIVE';
          r.snapshot.status = 'ACTIVE';
        },
      ],
      [
        'fraction',
        (r: any) => {
          r.snapshot.policy.parameters.feeCeilingVnd = 0.5;
        },
      ],
      [
        'overflow',
        (r: any) => {
          r.snapshot.policy.parameters.feeCeilingVnd = 9007199254740992;
        },
      ],
      [
        'missing',
        (r: any) => {
          delete r.snapshot.policy.parameters.feeCeilingVnd;
        },
      ],
      [
        'unknown',
        (r: any) => {
          r.snapshot.policy.parameters.verified = true;
        },
      ],
      [
        'fingerprint',
        (r: any) => {
          r.snapshot.policy.fingerprint = '0'.repeat(64);
        },
      ],
      [
        'gap',
        (r: any) => {
          r.revision += 1;
        },
      ],
    ] as const)('rejects direct invalid snapshot %s', async (_name, mutate) => {
      const before = await count();
      await expect(direct(mutate)).rejects.toThrow();
      expect(await count()).toBe(before);
    });
    it.each(['missing', 'wrong-before'] as const)(
      'rolls back a draft with %s strict audit',
      async (audit) => {
        const before = await count();
        await expect(direct(() => {}, audit)).rejects.toThrow();
        expect(await count()).toBe(before);
      },
    );
    it('fails the real service transaction if audit INSERT fails', async () => {
      const head = await current(),
        before = await count();
      await db.query(`CREATE FUNCTION w3_policy_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CI audit failure'; END $$;
        CREATE TRIGGER w3_policy_test_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION w3_policy_test_audit_failure()`);
      try {
        await expect(
          service.revise(head.id, request(head.state.revision), actor),
        ).rejects.toMatchObject({ status: 503 });
      } finally {
        await db.query(
          'DROP TRIGGER w3_policy_test_audit_failure ON audit_logs; DROP FUNCTION w3_policy_test_audit_failure()',
        );
      }
      expect(await count()).toBe(before);
    });
    it('enables RLS, revokes PUBLIC privileges, and checks API roles when present', async () => {
      const rows = await db.query(
        `SELECT relrowsecurity FROM pg_class WHERE oid = 'w3_delivery_policy_versions'::regclass`,
      );
      expect(rows[0].relrowsecurity).toBe(true);
      expect(
        await db.query(`SELECT acl.privilege_type FROM pg_class c
        CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
        WHERE c.oid = 'w3_delivery_policy_versions'::regclass AND acl.grantee = 0`),
      ).toHaveLength(0);
      expect(
        await db.query(
          'SELECT * FROM pg_policies WHERE schemaname = $1 AND tablename = $2',
          [schema, 'w3_delivery_policy_versions'],
        ),
      ).toHaveLength(0);
      // Stock PostgreSQL CI may lack Supabase roles; those branches remain unverified when absent.
      const roles = await db.query(
        `SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`,
      );
      for (const role of roles)
        for (const privilege of [
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
        ]) {
          const result = await db.query(
            'SELECT has_table_privilege($1, $2, $3) AS allowed',
            [role.rolname, `${schema}.w3_delivery_policy_versions`, privilege],
          );
          expect(result[0].allowed).toBe(false);
        }
    });
    it('refuses down migration when immutable history exists', async () => {
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await expect(
          new W3DeliveryOperatingPolicy1793466000006().down(runner),
        ).rejects.toThrow('Refusing to discard');
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
      expect(await count()).toBeGreaterThan(0);
    });

    it('requires exact same-transaction preview audit and rejects direct ACTIVE without a bound preview', async () => {
      const head = await current();
      const before = await count();
      const impact = previewW3DeliveryPolicyImpact(head.state, []);
      const preview = {
        id: randomUUID(),
        draftId: head.id,
        actorUserId: actor.id,
        impact,
      };
      await expect(
        db.getRepository('W3DeliveryPolicyPreview').insert(preview),
      ).rejects.toThrow('exact transactional audit');
      await expect(
        db.transaction(async (manager) => {
          await manager.insert('W3DeliveryPolicyPreview', preview);
          await manager.insert('AuditLog', {
            actorUserId: actor.id,
            actorRole: Role.ADMIN,
            action: 'W3_DELIVERY_POLICY_PREVIEW_CREATED',
            resourceType: 'w3_delivery_policy_preview',
            resourceId: preview.id,
            before: null,
            after: { draftId: randomUUID(), impact },
          });
        }),
      ).rejects.toThrow('exact transactional audit');
      await expect(
        db
          .getRepository('W3DeliveryPolicyVersion')
          .insert({
            id: randomUUID(),
            policyId: head.state.policy.policyId,
            contentVersion: head.state.policy.version,
            revision: head.state.revision + 1,
            status: 'ACTIVE',
            snapshot: {
              ...head.state,
              status: 'ACTIVE',
              revision: head.state.revision + 1,
            },
            createdByUserId: actor.id,
          }),
      ).rejects.toThrow('own exact server preview');
      expect(await db.getRepository('W3DeliveryPolicyPreview').count()).toBe(0);
      expect(await count()).toBe(before);
    });

    it('invalidates stale previews and atomically rolls back ACTIVE on strict audit failure', async () => {
      const first = await current();
      const old = await service.previewVersion(
        first.id,
        { expectedRevision: first.state.revision, samples: [] },
        actor,
      );
      const revised = await service.revise(
        first.id,
        request(first.state.revision),
        actor,
      );
      const head = revised.draft;
      await expect(
        service.activate(
          head.id,
          {
            expectedRevision: head.state.revision,
            previewId: old.preview.id,
            acknowledged: true,
          },
          actor,
        ),
      ).rejects.toMatchObject({ status: 409 });
      const fresh = await service.previewVersion(
        head.id,
        { expectedRevision: head.state.revision, samples: [] },
        actor,
      );
      const before = await count();
      await db.query(`CREATE FUNCTION w3_policy_test_activation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='W3_DELIVERY_POLICY_ACTIVATED' THEN RAISE EXCEPTION 'CI activation audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER w3_policy_test_activation_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION w3_policy_test_activation_failure()`);
      try {
        await expect(
          service.activate(
            head.id,
            {
              expectedRevision: head.state.revision,
              previewId: fresh.preview.id,
              acknowledged: true,
            },
            actor,
          ),
        ).rejects.toMatchObject({ status: 503 });
      } finally {
        await db.query(
          'DROP TRIGGER w3_policy_test_activation_failure ON audit_logs; DROP FUNCTION w3_policy_test_activation_failure()',
        );
      }
      expect(await count()).toBe(before);
      expect((await current()).id).toBe(head.id);
    });

    it('refuses lifecycle down with historical drafts or previews', async () => {
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await expect(
          new W3DeliveryPolicyLifecycle1793466000009().down(runner),
        ).rejects.toThrow('Refusing to discard');
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    });
  },
);
