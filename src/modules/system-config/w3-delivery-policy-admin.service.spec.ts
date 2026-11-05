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
          .filter((r) => !before || r.revision < before)
          .reverse()
          .slice(0, options.take),
      );
    }),
    insert: vi.fn(async (entity: unknown, row: any) => {
      if (entity === AuditLog) {
        if (state.failAudit) throw new Error('audit unavailable');
        audits.push(structuredClone(row));
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
