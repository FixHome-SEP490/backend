import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { User } from '../users/entities/user.entity';
import { Role } from '../../shared/enums';
import { W3DeliveryPolicyService } from './w3-delivery-policy-admin.service';
import { W3DeliveryPolicyStore } from './w3-delivery-policy-store.service';
import { W3DeliveryPolicyVersion } from './entities/w3-delivery-policy-version.entity';
import { W3DeliveryPolicyPreview } from './entities/w3-delivery-policy-preview.entity';

const actor = { id: '00000000-0000-4000-8000-000000000001', role: Role.ADMIN };
const parameters = {
  feeCeilingVnd: 50000,
  proposalReviewAfterMinutes: 30,
  courierEvidenceReviewAfterMinutes: 60,
};
const input = (expectedRevision = 0) => ({
  expectedRevision,
  parameters: { ...parameters },
});
const blockers = [
  'LEGAL_UNVERIFIED',
  'ACCOUNTING_UNVERIFIED',
  'WAREHOUSE_UNVERIFIED',
  'COURIER_UNVERIFIED',
  'SHIPPING_APPROVAL_SOURCE_UNVERIFIED',
  'FINANCE_CUTOVER_CLOSED',
];

/** Transaction scheduling double only: NOT proof of PostgreSQL locks/rollback. */
function fixture() {
  let rows: any[] = [],
    audits: any[] = [],
    previews: any[] = [],
    tail = Promise.resolve();
  const state = {
    failAudit: false,
    missingTable: false,
    permission: true,
    user: { ...actor, isActive: true, status: 'active' },
    transactions: 0,
  };
  const manager: any = {
    queryRunner: { isTransactionActive: true },
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('role_permissions')) {
        expect(params).toEqual([
          Role.ADMIN,
          expect.stringMatching(/^config:(read|update)$/),
        ]);
        return state.permission
          ? [{ role_id: 'role', permission_id: 'permission' }]
          : [];
      }
      throw new Error('Unexpected SQL');
    }),
    findOne: vi.fn(async (entity: unknown, options: any) => {
      if (entity === User) return state.user;
      if (entity === W3DeliveryPolicyPreview)
        return structuredClone(
          previews.find((p) => p.id === options.where.id) ?? null,
        );
      if (entity !== W3DeliveryPolicyVersion)
        throw new Error('Unexpected read');
      if (state.missingTable)
        throw Object.assign(new Error('private DB details'), {
          driverError: { code: '42P01' },
        });
      const candidates = options.where?.id
        ? rows.filter((r) => r.id === options.where.id)
        : rows;
      return structuredClone(candidates.at(-1) ?? null);
    }),
    find: vi.fn(async (entity: unknown, options: any) => {
      if (entity !== W3DeliveryPolicyVersion)
        throw new Error('Unexpected history');
      if (state.missingTable)
        throw Object.assign(new Error('private DB details'), {
          driverError: { code: '42P01' },
        });
      const before = options.where?.revision?._value;
      return structuredClone(
        rows
          .filter(
            (r) =>
              (!before || r.revision < before) &&
              (!options.where.status ||
                (r.status === 'DRAFT' && r.revision === r.contentVersion)),
          )
          .reverse()
          .slice(0, options.take),
      );
    }),
    insert: vi.fn(async (entity: unknown, row: any) => {
      if (entity === AuditLog) {
        if (state.failAudit) throw new Error('audit unavailable');
        audits.push(structuredClone(row));
      } else if (entity === W3DeliveryPolicyPreview) {
        previews.push(structuredClone(row));
      } else if (entity === W3DeliveryPolicyVersion) {
        rows.push(
          structuredClone({
            ...row,
            createdAt: new Date('2026-11-05T00:00:00Z'),
          }),
        );
      } else throw new Error('Unexpected write');
      return {};
    }),
  };
  const source: any = {
    transaction: async (isolation: string, run: (m: any) => unknown) => {
      state.transactions++;
      expect(isolation).toBe('READ COMMITTED');
      let release: () => void;
      let oldRows: any[],
        oldAudits: any[],
        oldPreviews: any[],
        wrote = false;
      const transactional = {
        ...manager,
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes('pg_advisory_xact_lock')) {
            const previous = tail;
            tail = new Promise<void>((resolve) => {
              release = resolve;
            });
            await previous;
          }
          return manager.query(sql, params);
        },
        insert: async (...args: unknown[]) => {
          if (!wrote) {
            oldRows = structuredClone(rows);
            oldAudits = structuredClone(audits);
            oldPreviews = structuredClone(previews);
            wrote = true;
          }
          return manager.insert(...args);
        },
      };
      try {
        return await run(transactional);
      } catch (error) {
        if (wrote) {
          rows = oldRows;
          audits = oldAudits;
          previews = oldPreviews;
        }
        throw error;
      } finally {
        release?.();
      }
    },
  };
  const audit = new AuditLogService(undefined as any);
  vi.spyOn((audit as any).logger, 'error').mockImplementation(() => {});
  const store = new W3DeliveryPolicyStore(audit);
  const service = new W3DeliveryPolicyService(source, store);
  return {
    state,
    source,
    manager,
    service,
    store,
    rows: () => rows,
    audits: () => audits,
  };
}

describe('W3 Admin inert persistence (unit transaction double, no DB/HTTP)', () => {
  it('retires by CAS without changing content identity, then starts the next content draft', async () => {
    const f = fixture();
    const first = (await f.service.create(input(), actor)).draft;
    const old = structuredClone(first);
    const retired = await (f.service as any).retire(
      first.id,
      { expectedRevision: 1 },
      actor,
    );
    expect(retired.version.state).toEqual({
      ...first.state,
      status: 'RETIRED',
      revision: 2,
    });
    expect(retired.version.state.policy).toEqual(first.state.policy);
    expect(first).toEqual(old);
    expect(f.rows()[0].snapshot).toEqual(old.state);
    expect(f.audits()[1]).toMatchObject({
      action: 'W3_DELIVERY_POLICY_RETIRED',
      before: old.state,
      after: retired.version.state,
    });
    await expect(
      f.service.revise(retired.version.id, input(2), actor),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      (f.service as any).retire(
        retired.version.id,
        { expectedRevision: 2 },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const next = await f.service.createVersion(input(2), actor);
    expect(next.version.state).toMatchObject({
      status: 'DRAFT',
      revision: 3,
      policy: { version: 2 },
    });
    expect(next.version.state.policy.fingerprint).not.toBe(
      old.state.policy.fingerprint,
    );
    const revised = await f.service.reviseVersion(
      next.version.id,
      input(3),
      actor,
    );
    expect(revised.version.state).toMatchObject({
      revision: 4,
      policy: { version: 3 },
    });
    expect(
      (await f.service.versionsHistory({}, actor)).versions.map(
        (d) => d.state.status,
      ),
    ).toEqual(['DRAFT', 'DRAFT', 'RETIRED', 'DRAFT']);
    expect((await f.service.current(actor)).draft).toBeNull();
    expect(
      (await f.service.history({}, actor)).drafts.map((d) => d.state.revision),
    ).toEqual([1]);
    await expect(f.service.create(input(2), actor)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      f.service.revise(next.version.id, input(3), actor),
    ).rejects.toMatchObject({ status: 409 });
    expect(next.financialExecution).toBe('BLOCKED');
    expect(next.effectivePolicy).toBeNull();
  });

  it('requires a server preview bound to the exact head and authenticated Admin before operating-only activation', async () => {
    const f = fixture();
    const head = (await f.service.create(input(), actor)).draft;
    const run = (id: string, body: any) =>
      (f.service as any).activate(id, body, actor);
    const consent = {
      expectedRevision: 1,
      previewId: randomUUID(),
      acknowledged: true,
    };
    await expect(
      run(head.id, { ...consent, expectedRevision: 2 }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'W3_DELIVERY_POLICY_REVISION_CONFLICT' },
    });
    await expect(run(randomUUID(), consent)).rejects.toMatchObject({
      status: 409,
    });
    await expect(run(head.id, consent)).rejects.toMatchObject({
      status: 409,
      response: { code: 'W3_DELIVERY_POLICY_PREVIEW_REQUIRED' },
    });
    await expect(
      run(head.id, {
        expectedRevision: 1,
        legal: { status: 'VERIFIED', evidenceRef: 'fake' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    const preview = await (f.service as any).previewVersion(
      head.id,
      { expectedRevision: 1, samples: [] },
      actor,
    );
    await expect(
      run(head.id, {
        ...consent,
        previewId: preview.preview.id,
        acknowledged: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
    f.state.user = {
      ...actor,
      id: randomUUID(),
      isActive: true,
      status: 'active',
    };
    await expect(
      (f.service as any).activate(
        head.id,
        { ...consent, previewId: preview.preview.id },
        f.state.user,
      ),
    ).rejects.toMatchObject({ status: 409 });
    f.state.user = { ...actor, isActive: true, status: 'active' };
    const active = await run(head.id, {
      ...consent,
      previewId: preview.preview.id,
    });
    expect(active.version.state).toEqual({
      ...head.state,
      status: 'ACTIVE',
      revision: 2,
    });
    expect(active.version.state.policy).toEqual(head.state.policy);
    expect(active.financialExecution).toBe('BLOCKED');
    expect(active.blockers).toEqual(blockers);
    expect((await f.service.current(actor)).draft).toBeNull();
    await expect(
      run(head.id, { ...consent, previewId: preview.preview.id }),
    ).rejects.toMatchObject({ status: 409 });
    const retired = await (f.service as any).retire(
      active.version.id,
      { expectedRevision: 2 },
      actor,
    );
    expect(retired.version.state).toEqual({
      ...head.state,
      status: 'RETIRED',
      revision: 3,
    });
    expect(f.rows()).toHaveLength(3);
    expect(
      f.audits().filter((a) => a.resourceType === 'w3_delivery_policy'),
    ).toHaveLength(3);
  });

  it('invalidates preview on revise, and legacy preview cannot authorize activation', async () => {
    const f = fixture();
    const head = (await f.service.create(input(), actor)).draft;
    await f.service.preview(
      { draftId: head.id, expectedRevision: 1, samples: [] },
      actor,
    );
    const preview = await (f.service as any).previewVersion(
      head.id,
      { expectedRevision: 1, samples: [] },
      actor,
    );
    const next = (await f.service.revise(head.id, input(1), actor)).draft;
    await expect(
      (f.service as any).activate(
        next.id,
        {
          expectedRevision: 2,
          previewId: preview.preview.id,
          acknowledged: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.rows()).toHaveLength(2);
  });

  it('rolls back activation if its strict audit fails', async () => {
    const f = fixture();
    const head = (await f.service.create(input(), actor)).draft;
    const preview = await (f.service as any).previewVersion(
      head.id,
      { expectedRevision: 1, samples: [] },
      actor,
    );
    f.state.failAudit = true;
    await expect(
      (f.service as any).activate(
        head.id,
        {
          expectedRevision: 1,
          previewId: preview.preview.id,
          acknowledged: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.rows()).toHaveLength(1);
    expect((await f.service.current(actor)).draft.state.status).toBe('DRAFT');
  });

  it('serializes retire/revise races and rejects stale lifecycle commands', async () => {
    const f = fixture();
    const head = (await f.service.create(input(), actor)).draft;
    const results = await Promise.allSettled([
      (f.service as any).retire(head.id, { expectedRevision: 1 }, actor),
      f.service.revise(head.id, input(1), actor),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toMatchObject([
      { reason: { status: 409 } },
    ]);
    await expect(
      (f.service as any).retire(head.id, { expectedRevision: 1 }, actor),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.rows()).toHaveLength(2);
    expect(f.audits()).toHaveLength(2);
  });

  it('rolls back retirement on strict audit failure and rechecks lifecycle permissions', async () => {
    const f = fixture();
    const head = (await f.service.create(input(), actor)).draft;
    f.state.failAudit = true;
    await expect(
      (f.service as any).retire(head.id, { expectedRevision: 1 }, actor),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.rows()).toHaveLength(1);
    expect(f.audits()).toHaveLength(1);
    f.state.failAudit = false;
    f.state.permission = false;
    for (const method of ['retire', 'activate']) {
      await expect(
        (f.service as any)[method](
          head.id,
          {
            expectedRevision: 1,
            ...(method === 'activate'
              ? { previewId: randomUUID(), acknowledged: true }
              : {}),
          },
          actor,
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it('returns no effective policy and explicit blockers before any draft exists', async () => {
    const f = fixture();
    expect(await f.service.current(actor)).toMatchObject({
      draft: null,
      effectivePolicy: null,
      financialExecution: 'BLOCKED',
      blockers,
    });
    expect(f.rows()).toHaveLength(0);
  });
  it('creates one explicit DRAFT snapshot with strict before/after audit', async () => {
    const f = fixture();
    const result = await f.service.create(input(), actor);
    expect(result).toMatchObject({
      effectivePolicy: null,
      financialExecution: 'BLOCKED',
      blockers,
      draft: {
        state: {
          status: 'DRAFT',
          revision: 1,
          policy: { version: 1, parameters },
        },
      },
    });
    expect(f.rows()).toHaveLength(1);
    expect(f.audits()).toMatchObject([
      {
        actorUserId: actor.id,
        actorRole: Role.ADMIN,
        action: 'W3_DELIVERY_POLICY_DRAFT_CREATED',
        before: null,
        after: { status: 'DRAFT', revision: 1 },
      },
    ]);
    expect(
      (await f.service.current(actor)).draft.state.policy.fingerprint,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      f.manager.findOne.mock.calls.find(
        ([entity]: any[]) => entity === User,
      )?.[1].lock,
    ).toEqual({ mode: 'pessimistic_read' });
  });
  it.each([
    -1,
    0.1,
    '50000',
    null,
    undefined,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid VND %s without writing', async (feeCeilingVnd) => {
    const f = fixture();
    await expect(
      f.service.create(
        { ...input(), parameters: { ...parameters, feeCeilingVnd } } as any,
        actor,
      ),
    ).rejects.toThrow();
    expect(f.rows()).toEqual([]);
    expect(f.audits()).toEqual([]);
  });
  it.each([0, Number.MAX_SAFE_INTEGER])(
    'accepts explicit safe boundary %s without enabling finance',
    async (feeCeilingVnd) => {
      const f = fixture();
      const result = await f.service.create(
        { ...input(), parameters: { ...parameters, feeCeilingVnd } },
        actor,
      );
      expect(result.draft.state.policy.parameters.feeCeilingVnd).toBe(
        feeCeilingVnd,
      );
      expect(result.blockers).toEqual(blockers);
    },
  );
  it.each([
    { status: 'ACTIVE' },
    { financialExecution: 'ENABLED' },
    { legal: { status: 'VERIFIED', evidenceRef: 'fake' } },
    { actor: { role: Role.ADMIN } },
    { effectiveAt: '2020-01-01' },
    { __proto__: { verified: true } },
  ])('rejects extra authority and inherited payloads %j', async (extra) => {
    const f = fixture();
    const payload =
      Object.getPrototypeOf(extra) === Object.prototype
        ? { ...input(), ...extra }
        : Object.assign(Object.create(Object.getPrototypeOf(extra)), input());
    await expect(f.service.create(payload, actor)).rejects.toThrow();
    expect(f.rows()).toHaveLength(0);
  });
  it('rejects nested extra fields and missing parameters, without defaults', async () => {
    const f = fixture();
    for (const payload of [
      { expectedRevision: 0 },
      { ...input(), parameters: { ...parameters, fixedFeeVnd: 0 } },
      { ...input(), parameters: {} },
    ]) {
      await expect(f.service.create(payload as any, actor)).rejects.toThrow();
    }
    expect(f.rows()).toHaveLength(0);
  });
  it('appends a new immutable content version; preserves previous response and journal', async () => {
    const f = fixture();
    const first = await f.service.create(input(), actor);
    const historical = structuredClone(first);
    const next = await f.service.revise(
      first.draft.id,
      {
        expectedRevision: 1,
        parameters: { ...parameters, feeCeilingVnd: 60000 },
      },
      actor,
    );
    expect(next.draft.state).toMatchObject({
      status: 'DRAFT',
      revision: 2,
      policy: { version: 2, parameters: { feeCeilingVnd: 60000 } },
    });
    expect(next.draft.id).not.toBe(first.draft.id);
    expect(first).toEqual(historical);
    expect(f.rows()[0].snapshot).toEqual(historical.draft.state);
    expect(f.audits()[1].before).toEqual(historical.draft.state);
    expect(
      (await f.service.history({}, actor)).drafts.map(
        (d: any) => d.state.revision,
      ),
    ).toEqual([2, 1]);
    expect(
      (
        await f.service.history({ beforeRevision: 2, limit: 1 }, actor)
      ).drafts.map((d: any) => d.state.revision),
    ).toEqual([1]);
  });
  it('rejects duplicate initial create and stale/replayed PATCH rather than creating new versions', async () => {
    const f = fixture();
    const first = await f.service.create(input(), actor);
    await expect(f.service.create(input(), actor)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      f.service.revise(first.draft.id, input(2), actor),
    ).rejects.toMatchObject({ status: 409 });
    await f.service.revise(first.draft.id, input(1), actor);
    await expect(
      f.service.revise(first.draft.id, input(1), actor),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.rows()).toHaveLength(2);
    expect(f.audits()).toHaveLength(2);
  });
  it('allows only one of two concurrent writers at the same expected revision', async () => {
    const f = fixture();
    const first = await f.service.create(input(), actor);
    const results = await Promise.allSettled([
      f.service.revise(first.draft.id, input(1), actor),
      f.service.revise(first.draft.id, input(1), actor),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toMatchObject([
      { reason: { status: 409 } },
    ]);
    expect(f.rows()).toHaveLength(2);
    expect(f.audits()).toHaveLength(2);
  });
  it('rolls back both create and revise if real strict audit insert fails', async () => {
    const f = fixture();
    f.state.failAudit = true;
    await expect(f.service.create(input(), actor)).rejects.toThrow();
    expect(f.rows()).toEqual([]);
    expect(f.audits()).toEqual([]);
    f.state.failAudit = false;
    const first = await f.service.create(input(), actor);
    f.state.failAudit = true;
    await expect(
      f.service.revise(first.draft.id, input(1), actor),
    ).rejects.toThrow();
    expect(f.rows()).toHaveLength(1);
    expect(f.audits()).toHaveLength(1);
    expect((await f.service.current(actor)).draft.state.revision).toBe(1);
  });
  it.each([Role.CUSTOMER, Role.TECHNICIAN, Role.SERVICE_MANAGER, undefined])(
    'denies role %s before policy reads',
    async (role) => {
      const f = fixture();
      await expect(
        f.service.current({ ...actor, role } as any),
      ).rejects.toThrow();
      expect(
        f.manager.findOne.mock.calls.filter(
          ([entity]: any[]) => entity === W3DeliveryPolicyVersion,
        ),
      ).toHaveLength(0);
    },
  );
  it.each(['inactive', 'role-revoked', 'missing-permission', 'missing-user'])(
    'revalidates current DB authority: %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'inactive') f.state.user.isActive = false;
      if (kind === 'role-revoked')
        f.state.user.role = Role.SERVICE_MANAGER as any;
      if (kind === 'missing-permission') f.state.permission = false;
      if (kind === 'missing-user') f.state.user = null as any;
      await expect(f.service.create(input(), actor)).rejects.toMatchObject({
        status: 403,
      });
      expect(f.rows()).toHaveLength(0);
    },
  );
  it('fails closed on missing migration, without DB details or fallback to config/defaults', async () => {
    const f = fixture();
    f.state.missingTable = true;
    for (const run of [
      () => f.service.current(actor),
      () => f.service.history({}, actor),
      () => f.service.create(input(), actor),
      () =>
        f.service.preview(
          { draftId: randomUUID(), expectedRevision: 1, samples: [] },
          actor,
        ),
    ]) {
      await expect(run()).rejects.toMatchObject({ status: 503 });
    }
    expect(f.rows()).toHaveLength(0);
  });
  it('rejects injection IDs and foreign/stale snapshot IDs without any new write', async () => {
    const f = fixture();
    const first = await f.service.create(input(), actor);
    await expect(
      f.service.revise("'; DROP TABLE users;--", input(1), actor),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.service.revise(randomUUID(), input(1), actor),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.service.preview(
        { draftId: randomUUID(), expectedRevision: 1, samples: [] },
        actor,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await f.service.current(actor)).draft.id).toBe(first.draft.id);
    expect(f.rows()).toHaveLength(1);
  });
  it('previews hypothetical samples against an exact historical snapshot with all blockers', async () => {
    const f = fixture();
    const first = await f.service.create(input(), actor);
    await f.service.revise(first.draft.id, input(1), actor);
    const payload = {
      draftId: first.draft.id,
      expectedRevision: 1,
      samples: [
        {
          proposalId: 'hypothetical-1',
          proposalVersion: 1,
          shippingFeeVnd: 5,
          proposalAgeMinutes: 40,
          courierEvidenceAgeMinutes: null,
        },
      ],
    };
    const result = await f.service.preview(payload, actor);
    expect(result).toMatchObject({
      blockers,
      financialExecution: 'BLOCKED',
      hypotheticalOnly: true,
      policyRevision: 1,
      totals: {
        shippingFeeVnd: 5,
        customerShippingShare: 4,
        technicianShippingShare: 1,
      },
    });
    expect(result.proposals[0].policySnapshot).toEqual(
      first.draft.state.policy,
    );
    expect(result.proposals[0].courierEvidenceReviewDue).toBeNull();
    expect(f.rows()).toHaveLength(2);
    expect(f.audits()).toHaveLength(2);
    await expect(
      f.service.preview({ ...payload, verified: true } as any, actor),
    ).rejects.toThrow();
    await expect(
      f.service.preview({ ...payload, expectedRevision: 2 }, actor),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rejects persisted corruption/ACTIVE and fingerprints instead of trusting stored flags', async () => {
    const f = fixture();
    await f.service.create(input(), actor);
    f.rows()[0].snapshot.status = 'ACTIVE';
    await expect(f.service.current(actor)).rejects.toMatchObject({
      status: 503,
    });
    f.rows()[0].snapshot.status = 'DRAFT';
    f.rows()[0].snapshot.policy.fingerprint = '0'.repeat(64);
    await expect(f.service.current(actor)).rejects.toMatchObject({
      status: 503,
    });
  });
});
