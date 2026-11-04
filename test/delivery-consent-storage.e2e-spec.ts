// Real CI PostgreSQL only. Never load dotenv, DATABASE_* or application modules.
import 'reflect-metadata';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource, EntityManager } from 'typeorm';
import { Role } from '../src/shared/enums';
import { createDeliveryProposal } from '../src/modules/part-requests/delivery-consent.policy';
import type { DeliveryConsentStoreService } from '../src/modules/part-requests/delivery-consent-store.service';

describe.skipIf(
  process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true',
)('B1 isolated delivery consent PostgreSQL storage (no HTTP/finance)', () => {
  const schema = `delivery_consent_e2e_${randomUUID().replaceAll('-', '')}`;
  let root: DataSource,
    db: DataSource,
    store: DeliveryConsentStoreService,
    serviceId: string;
  const save = (name: string, row: object) => db.getRepository(name).save(row);
  beforeAll(async () => {
    // Same ephemeral postgres:16 CI service as warehouse-w3-finance; no shared DB option.
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
      !/^delivery_consent_e2e_[a-f0-9]{32}$/.test(schema)
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
    // Existing private-schema harness exclusions: these historical migrations hardcode public.
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
    // Use the compiled store AND its compiled entity identities, as loaded by DataSource.
    const runtime = createRequire(resolve('package.json'));
    store = new (runtime(
      resolve('dist/modules/part-requests/delivery-consent-store.service.js'),
    ).DeliveryConsentStoreService)();
    const category = await save('ServiceCategory', {
      code: randomUUID(),
      name: 'B1 synthetic category',
    });
    serviceId = (
      await save('Service', {
        categoryId: category.id,
        code: randomUUID(),
        name: 'B1 synthetic repair',
        pricingMode: 'fixed_price',
        fixedPrice: 100000,
      })
    ).id;
  }, 60000);
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (root?.isInitialized) {
      if (!/^delivery_consent_e2e_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe fixture cleanup');
      await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await root.destroy();
    }
  });

  async function fixture() {
    const user = (role: Role) =>
      save('User', {
        email: `${randomUUID()}@example.test`,
        passwordHash: 'ci-no-login',
        fullName: 'B1 synthetic actor',
        role,
        status: 'active',
        isActive: true,
      });
    const customer = await user(Role.CUSTOMER),
      technician = await user(Role.TECHNICIAN),
      sm = await user(Role.SERVICE_MANAGER);
    const booking = await save('Booking', {
      customerId: customer.id,
      serviceId,
      description: 'B1 synthetic booking',
      status: 'matched',
    });
    const order = await save('ServiceOrder', {
      bookingId: booking.id,
      code: `B1-${randomUUID()}`,
      status: 'under_repair',
    });
    const assignment = await save('TechnicianAssignment', {
      serviceOrderId: order.id,
      technicianId: technician.id,
      isActive: true,
    });
    const cost = await save('AdditionalCostRequest', {
      serviceOrderId: order.id,
      technicianId: technician.id,
      status: 'approved',
      reason: 'B1 synthetic source',
      decidedAt: new Date(),
      decidedByCustomerId: customer.id,
      expiresAt: new Date(Date.now() + 86400000),
      fulfillmentMethod: 'delivery',
      shippingFee: 20000,
    });
    const request = await save('PartRequest', {
      serviceOrderId: order.id,
      technicianId: technician.id,
      requestType: 'additional',
      fulfillmentMethod: 'delivery',
      additionalCostId: cost.id,
    });
    const actor = (u: any) => ({ id: u.id, role: u.role as Role });
    const evidence = {
      id: randomUUID(),
      purpose: 'QUOTE' as const,
      quoteVersion: 1,
      privateObjectRef: `cloudinary://evidence/fixhome/evidence/${order.id}/${sm.id}/${randomUUID()}`,
      contentDigest: 'a'.repeat(64),
      mimeType: 'image/jpeg',
      fileSize: 1024,
      retainUntil: null,
    };
    const command = {
      kind: 'PROPOSE' as const,
      commandId: randomUUID(),
      expectedVersion: 0,
      totalShippingFee: 20000,
      budget: {
        laborTotal: 100000,
        commissionAmount: 10000,
        knownApprovedDeductions: 0,
      },
      evidenceRef: `delivery-evidence:${evidence.id}`,
      approvedCostRef: `additional-cost:${cost.id}`,
    };
    const scope = {
      partRequestId: request.id,
      serviceOrderId: order.id,
      customerId: customer.id,
      technicianId: technician.id,
      responsibleServiceManagerId: sm.id,
    };
    const start = () =>
      db.transaction(async (m) => {
        await store.appendEvidence(m, request.id, evidence, actor(sm));
        return store.execute(m, request.id, command, actor(sm));
      });
    const consent = (state: any, u: any, commandId = randomUUID()) => ({
      kind: 'CONSENT' as const,
      commandId,
      expectedVersion: state.version,
      quoteVersion: state.quote.quoteVersion,
      quoteFingerprint: state.quote.fingerprint,
      totalShippingFee: state.quote.totalShippingFee,
      shippingShare:
        u.id === customer.id
          ? state.quote.customerShippingShare
          : state.quote.technicianShippingShare,
      accepted: true as const,
      evidenceRef: `delivery-consent:${request.id}:${commandId}`,
    });
    const rootRow = () => {
      const { receipts: _receipts, ...projection } = createDeliveryProposal(
        scope,
        command,
        actor(sm),
      );
      return {
        partRequestId: request.id,
        serviceOrderId: order.id,
        customerId: customer.id,
        technicianId: technician.id,
        assignmentId: assignment.id,
        responsibleServiceManagerId: sm.id,
        warehouseId: null,
        sourceQuotationId: null,
        sourceAdditionalCostId: cost.id,
        version: 1,
        quoteVersion: 1,
        status: projection.status,
        projection,
        invalidatedAt: null,
        invalidationReason: null,
      };
    };
    return {
      customer,
      technician,
      sm,
      booking,
      order,
      assignment,
      cost,
      request,
      actor,
      evidence,
      command,
      start,
      consent,
      rootRow,
    };
  }
  const count = async (table: string, requestId: string) =>
    Number(
      (
        await db.query(
          `SELECT count(*) AS n FROM ${table} WHERE part_request_id=$1`,
          [requestId],
        )
      )[0].n,
    );

  it('runs the real forward migration with RLS/no API grants and keeps W3 invoice CHECK closed', async () => {
    const tables = await db.query(
      `SELECT relname,relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND relname IN ('delivery_consent_sessions','delivery_consent_commands','delivery_evidence_records')`,
      [schema],
    );
    expect(tables).toHaveLength(3);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
    expect(
      await db.query(
        `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
      WHERE n.nspname=$1 AND c.relname IN ('delivery_consent_sessions','delivery_consent_commands','delivery_evidence_records')
      AND (acl.grantee=0 OR acl.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')))`,
        [schema],
      ),
    ).toHaveLength(0);
    expect(
      await db.query(
        `SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1 AND c.conname='ck_invoice_shipping_cutover_closed'`,
        [schema],
      ),
    ).toHaveLength(1);
    const warehouseCheck = await db.query(
      `SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1 AND t.relname='delivery_consent_sessions' AND c.conname='ck_delivery_b1_no_warehouse'`,
      [schema],
    );
    expect(warehouseCheck).toHaveLength(1);
    expect(warehouseCheck[0].definition).toContain('warehouse_id IS NULL');
  });
  it('persists a Phase A state, exact replay and no warehouse/stock/finance artifacts', async () => {
    const f = await fixture();
    const first = await f.start();
    const replay = await db.transaction((m) =>
      store.execute(m, f.request.id, f.command, f.actor(f.sm)),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.state).toEqual(first.state);
    expect(await db.transaction((m) => store.read(m, f.request.id))).toEqual(
      first.state,
    );
    expect(await count('delivery_consent_commands', f.request.id)).toBe(1);
    expect(
      await count('part_request_warehouse_allocations', f.request.id),
    ).toBe(0);
    expect(
      await db.getRepository('Invoice').countBy({ serviceOrderId: f.order.id }),
    ).toBe(0);
  });
  it.each([0, 1, 5, Number.MAX_SAFE_INTEGER])(
    'roundtrips exact VND boundary %s through bigint/JSONB',
    async (total) => {
      const f = await fixture();
      const command = {
        ...f.command,
        totalShippingFee: total,
        budget: {
          laborTotal: Number.MAX_SAFE_INTEGER,
          commissionAmount: 0,
          knownApprovedDeductions: 0,
        },
      };
      const result = await db.transaction(async (m) => {
        await store.appendEvidence(m, f.request.id, f.evidence, f.actor(f.sm));
        return store.execute(m, f.request.id, command, f.actor(f.sm));
      });
      const read = await db.transaction((m) => store.read(m, f.request.id));
      expect(read).toEqual(result.state);
      const customer = Number((7n * BigInt(total) + 5n) / 10n);
      expect(read.quote.customerShippingShare).toBe(customer);
      expect(read.quote.technicianShippingShare).toBe(total - customer);
    },
  );
  it.each([
    'order',
    'technician',
    'customer',
    'assignment',
    'source',
    'warehouse',
  ])(
    'rejects disallowed or mismatched %s scope at SQL INSERT',
    async (mismatch) => {
      const f = await fixture(),
        other = await fixture();
      const row = f.rootRow();
      if (mismatch === 'order') row.serviceOrderId = other.order.id;
      if (mismatch === 'technician') row.technicianId = other.technician.id;
      if (mismatch === 'customer') row.customerId = other.customer.id;
      if (mismatch === 'assignment') row.assignmentId = other.assignment.id;
      if (mismatch === 'source') row.sourceAdditionalCostId = other.cost.id;
      if (mismatch === 'warehouse') row.warehouseId = randomUUID();
      // Keep the JSON identity consistent with the forged root: trigger must verify real scope.
      row.projection.scope = {
        ...row.projection.scope,
        serviceOrderId: row.serviceOrderId,
        customerId: row.customerId,
        technicianId: row.technicianId,
      };
      const insert = db.transaction((m) =>
        m.getRepository('DeliveryConsentSession').insert(row),
      );
      if (mismatch === 'warehouse')
        await expect(insert).rejects.toThrow('Delivery scope mismatch');
      else await expect(insert).rejects.toThrow();
      expect(await count('delivery_consent_sessions', f.request.id)).toBe(0);
    },
  );
  it('rejects root-only INSERT at deferred commit rather than leaving an empty journal', async () => {
    const f = await fixture();
    await expect(
      db.transaction((m) =>
        m.getRepository('DeliveryConsentSession').insert(f.rootRow()),
      ),
    ).rejects.toThrow('Incomplete delivery command journal');
    expect(await count('delivery_consent_sessions', f.request.id)).toBe(0);
  });
  it.each(['delivery_consent_commands', 'delivery_evidence_records'])(
    'rejects UPDATE and DELETE of %s',
    async (table) => {
      const f = await fixture();
      await f.start();
      await expect(
        db.query(
          `UPDATE ${table} SET created_at=now() WHERE part_request_id=$1`,
          [f.request.id],
        ),
      ).rejects.toThrow('append only');
      await expect(
        db.query(`DELETE FROM ${table} WHERE part_request_id=$1`, [
          f.request.id,
        ]),
      ).rejects.toThrow('append only');
    },
  );
  it('serializes same-command concurrent replay and conflicts on a reused key/body', async () => {
    const f = await fixture();
    await db.transaction((m) =>
      store.appendEvidence(m, f.request.id, f.evidence, f.actor(f.sm)),
    );
    const run = () =>
      db.transaction((m) =>
        store.execute(m, f.request.id, f.command, f.actor(f.sm)),
      );
    const results = await Promise.all([run(), run()]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await count('delivery_consent_commands', f.request.id)).toBe(1);
    await expect(
      db.transaction((m) =>
        store.execute(
          m,
          f.request.id,
          { ...f.command, totalShippingFee: 21000 },
          f.actor(f.sm),
        ),
      ),
    ).rejects.toThrow('COMMAND_CONFLICT');
  });
  it('allows one winner for two new consent commands with the same expectedVersion', async () => {
    const f = await fixture();
    const first = await f.start();
    const results = await Promise.allSettled(
      [f.customer, f.technician].map((u) =>
        db.transaction((m) =>
          store.execute(m, f.request.id, f.consent(first.state, u), f.actor(u)),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(String(loser.reason)).toContain('STALE_VERSION');
    expect(await count('delivery_consent_commands', f.request.id)).toBe(2);
  });
  it('persists dual consents then a lower actual separately, never touching the invoice', async () => {
    const f = await fixture();
    let result = await f.start();
    for (const actor of [f.customer, f.technician])
      result = await db.transaction((m) =>
        store.execute(
          m,
          f.request.id,
          f.consent(result.state, actor),
          f.actor(actor),
        ),
      );
    const evidence = {
      ...f.evidence,
      id: randomUUID(),
      purpose: 'ACTUAL' as const,
    };
    result = await db.transaction(async (m) => {
      await store.appendEvidence(m, f.request.id, evidence, f.actor(f.sm));
      return store.execute(
        m,
        f.request.id,
        {
          kind: 'RECORD_ACTUAL',
          commandId: randomUUID(),
          expectedVersion: 3,
          quoteVersion: 1,
          totalShippingFee: 15000,
          evidenceRef: `delivery-evidence:${evidence.id}`,
        },
        f.actor(f.sm),
      );
    });
    expect(result.state.status).toBe('ACTUAL_RECORDED');
    expect(result.state.quote.totalShippingFee).toBe(20000);
    expect(result.state.actual.totalShippingFee).toBe(15000);
    expect(result.state.payoutBlockReason).toBe('FINANCIAL_CUTOVER_CLOSED');
  });
  it('rolls back root, command and evidence if the caller aborts after the store returns', async () => {
    const f = await fixture();
    await expect(
      db.transaction(async (m) => {
        await store.appendEvidence(m, f.request.id, f.evidence, f.actor(f.sm));
        await store.execute(m, f.request.id, f.command, f.actor(f.sm));
        throw new Error('caller abort');
      }),
    ).rejects.toThrow('caller abort');
    for (const table of [
      'delivery_consent_sessions',
      'delivery_consent_commands',
      'delivery_evidence_records',
    ])
      expect(await count(table, f.request.id)).toBe(0);
    expect(
      await db.getRepository('AuditLog').countBy({ resourceId: f.request.id }),
    ).toBe(0);
  });
  it('does not block legal reassignment; blocks stale writes and explicitly invalidates without rewriting history', async () => {
    const f = await fixture();
    await f.start();
    await db
      .getRepository('TechnicianAssignment')
      .update(f.assignment.id, { isActive: false });
    await expect(
      db.transaction((m) =>
        store.execute(m, f.request.id, f.command, f.actor(f.sm)),
      ),
    ).rejects.toThrow('SCOPE_CHANGED');
    expect(
      await db.transaction((m) =>
        store.invalidateIfScopeChanged(m, f.request.id),
      ),
    ).toBe(true);
    expect(
      (await db.transaction((m) => store.read(m, f.request.id))).version,
    ).toBe(1);
    expect(await count('delivery_consent_commands', f.request.id)).toBe(1);
    await expect(
      db.query(
        'UPDATE delivery_consent_sessions SET invalidated_at=NULL,invalidation_reason=NULL WHERE part_request_id=$1',
        [f.request.id],
      ),
    ).rejects.toThrow('immutable');
  });
  it('rejects evidence for another order directly in SQL, with no existing session required', async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      db.getRepository('DeliveryEvidenceRecord').insert({
        ...f.evidence,
        partRequestId: f.request.id,
        serviceOrderId: other.order.id,
        uploaderUserId: f.sm.id,
        privateObjectRef: `cloudinary://evidence/fixhome/evidence/${other.order.id}/${f.sm.id}/${randomUUID()}`,
      }),
    ).rejects.toThrow('scope mismatch');
  });
  it('refuses schema downgrade after receipt history exists', async () => {
    const f = await fixture();
    await f.start();
    const runtime = createRequire(resolve('package.json'));
    const Migration = runtime(
      resolve('dist/database/migrations/1793466000005-DeliveryConsentState.js'),
    ).DeliveryConsentState1793466000005;
    await expect(
      db.transaction((m: EntityManager) => new Migration().down(m.queryRunner)),
    ).rejects.toThrow('Refusing to discard');
  });
});
