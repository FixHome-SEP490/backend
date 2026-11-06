// Existing ephemeral CI PostgreSQL ONLY. No dotenv/DATABASE_* or shared DEV fallback.
import 'reflect-metadata';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { WarehouseDeliveryStore } from '../src/modules/part-requests/warehouse-delivery-store.service';
import type { DeliveryOperationsService } from '../src/modules/part-requests/delivery-operations.service';
import { DeliveryZeroFeeOperations1793466000008 } from '../src/database/migrations/1793466000008-DeliveryZeroFeeOperations';
import { Role } from '../src/shared/enums';
import { WarehouseDeliveryPhysical1793466000007 } from '../src/database/migrations/1793466000007-WarehouseDeliveryPhysical';

describe.skipIf(
  process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true',
)('W3 physical closed PostgreSQL gate and journal', () => {
  const schema = `w3_physical_e2e_${randomUUID().replaceAll('-', '')}`;
  let root: DataSource,
    db: DataSource,
    store: WarehouseDeliveryStore,
    serviceId: string;
  const save = (name: string, row: object) => db.getRepository(name).save(row);
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
      !/^w3_physical_e2e_[a-f0-9]{32}$/.test(schema)
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
    // Same exclusions as B1/B3a: historical migrations explicitly hardcode public schema.
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
    await db.query(`INSERT INTO system_configs(key,value,value_type) VALUES ('commission.rate_bps','1000','int')
      ON CONFLICT(key) DO UPDATE SET value='1000',value_type='int'`);
    const runtime = createRequire(resolve('package.json'));
    store = new (runtime(
      resolve('dist/modules/part-requests/warehouse-delivery-store.service.js'),
    ).WarehouseDeliveryStore)();
    const category = await save('ServiceCategory', {
      code: randomUUID(),
      name: 'W3 physical CI category',
    });
    serviceId = (
      await save('Service', {
        categoryId: category.id,
        code: randomUUID(),
        name: 'W3 physical CI repair',
        pricingMode: 'fixed_price',
        fixedPrice: 100000,
      })
    ).id;
  }, 60000);
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (root?.isInitialized) {
      if (!/^w3_physical_e2e_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe CI cleanup');
      await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await root.destroy();
    }
  });

  async function fixture(enroll = true, automatic = false, shippingFee = 0) {
    const user = (role: Role) =>
      save('User', {
        email: `${randomUUID()}@example.test`,
        passwordHash: 'ci-no-login',
        fullName: 'W3 physical CI actor',
        role,
        status: 'active',
        isActive: true,
      });
    const customer = await user(Role.CUSTOMER),
      tech = await user(Role.TECHNICIAN);
    const booking = await save('Booking', {
      customerId: customer.id,
      serviceId,
      description: 'CI physical fixture',
      status: 'matched',
      pricingModeSnapshot: 'fixed_price',
      fixedUnitPriceSnapshot: 100000,
    });
    const order = await save('ServiceOrder', {
      bookingId: booking.id,
      code: `W3-${randomUUID()}`,
      status: 'under_repair',
    });
    const assignment = await save('TechnicianAssignment', {
      serviceOrderId: order.id,
      technicianId: tech.id,
      isActive: true,
    });
    const cost = await save('AdditionalCostRequest', {
      serviceOrderId: order.id,
      technicianId: tech.id,
      reason: 'CI approved parts',
      status: 'approved',
      decidedAt: new Date(),
      decidedByCustomerId: customer.id,
      expiresAt: new Date(Date.now() + 86400000),
      fulfillmentMethod: 'delivery',
      shippingFee,
    });
    const part = await save('FixHomePart', {
      sku: randomUUID(),
      name: 'CI physical part',
      sellingPrice: 1000,
      isActive: true,
    });
    await save('AdditionalCostItem', {
      requestId: cost.id,
      type: 'parts_equipment',
      description: 'CI part',
      partSource: 'fixhome',
      partCatalogId: part.id,
      quantity: 2,
      unitPrice: 1000,
      lineTotal: 2000,
    });
    const actor = { id: tech.id, role: Role.TECHNICIAN };
    const request = await db.transaction(async (m) => {
      if (automatic) {
        const runtime = createRequire(resolve('package.json'));
        const Service = runtime(
          resolve('dist/modules/part-requests/part-requests.service.js'),
        ).PartRequestsService;
        const audit = {
          logWithManager: async (manager: any, entry: object) =>
            manager.getRepository('AuditLog').insert(entry),
        };
        const service = new Service(
          db,
          db.getRepository('PartRequest'),
          db.getRepository('PartRequestItem'),
          db.getRepository('FixHomePart'),
          audit,
          {},
        );
        const created = await service.createAdditionalRequestFromApprovedCost(
          m,
          order.id,
          tech.id,
          cost.id,
          'delivery',
          shippingFee,
          [
            {
              partCatalogId: part.id,
              partName: 'CI part',
              quantity: 2,
              unitPrice: 1000,
              partSource: 'fixhome',
            },
          ],
        );
        if (!created)
          throw new Error('Expected new full-source delivery request');
        return created;
      }
      const r = await m.getRepository('PartRequest').save({
        serviceOrderId: order.id,
        technicianId: tech.id,
        requestType: 'additional',
        fulfillmentMethod: 'delivery',
        additionalCostId: cost.id,
        shippingFee,
      });
      await m.getRepository('PartRequestItem').save({
        partRequestId: r.id,
        partCatalogId: part.id,
        partSource: 'fixhome',
        partNameSnapshot: 'CI part',
        quantity: 2,
        unitPriceSnapshot: 1000,
      });
      if (enroll) await store.enrollNew(m, r.id, actor);
      return r;
    });
    const command = {
      commandId: randomUUID(),
      expectedVersion: 0,
      kind: 'RESERVE' as const,
    };
    const execute = (cmd = command, principal = actor) =>
      db.transaction((m) => store.execute(m, request.id, cmd, principal));
    return {
      request,
      actor,
      command,
      execute,
      assignment,
      cost,
      order,
      booking,
      customer,
      part,
    };
  }
  const eventCount = (id: string) =>
    db.getRepository('WarehouseDeliveryEvent').countBy({ partRequestId: id });

  it('creates no cohorts automatically, refuses enrollment of committed legacy requests', async () => {
    const f = await fixture(false);
    expect(
      await db.query(
        'SELECT * FROM warehouse_delivery_cohorts WHERE part_request_id=$1',
        [f.request.id],
      ),
    ).toHaveLength(0);
    await expect(
      db.transaction((m) => store.enrollNew(m, f.request.id, f.actor)),
    ).rejects.toThrow('new DELIVERY');
    await expect(f.execute()).rejects.toThrow('LEGACY_REQUEST');
    expect(await eventCount(f.request.id)).toBe(0);
  });
  it('persists pending assistance and exact replay without any stock/QR/finance mutation', async () => {
    const f = await fixture();
    const before = await db.query(
      'SELECT count(*)::int AS n FROM warehouse_stock',
    );
    expect((await f.execute()).state).toMatchObject({
      status: 'PENDING_ASSISTANCE',
      reason: 'SHIPPING_APPROVAL_SOURCE_UNVERIFIED',
      quantities: [],
      warehouseId: null,
    });
    expect((await f.execute()).replayed).toBe(true);
    expect(await eventCount(f.request.id)).toBe(1);
    expect(
      await db.query('SELECT count(*)::int AS n FROM warehouse_stock'),
    ).toEqual(before);
    expect(
      await db.query(
        'SELECT * FROM warehouse_delivery_movements WHERE part_request_id=$1',
        [f.request.id],
      ),
    ).toHaveLength(0);
    expect(
      (
        await db
          .getRepository('PartRequest')
          .findOneByOrFail({ id: f.request.id })
      ).receivedAt,
    ).toBeNull();
    expect(
      await db.getRepository('Invoice').countBy({ serviceOrderId: f.order.id }),
    ).toBe(0);
  });
  it('serializes CAS race and idempotent same-command retry across connections', async () => {
    const f = await fixture();
    const different = await Promise.allSettled([
      f.execute(),
      f.execute({ ...f.command, commandId: randomUUID() }),
    ]);
    expect(different.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(different.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const g = await fixture();
    const same = await Promise.all([g.execute(), g.execute()]);
    expect(same.filter((r) => r.replayed)).toHaveLength(1);
    expect(await eventCount(g.request.id)).toBe(1);
  });
  it('rejects changed payload/actor, revoked assignment and wrong customer approval', async () => {
    const f = await fixture();
    await f.execute();
    await expect(
      f.execute({ ...f.command, expectedVersion: 1 }),
    ).rejects.toThrow('COMMAND_CONFLICT');
    await expect(
      f.execute(f.command, { ...f.actor, id: randomUUID() }),
    ).rejects.toThrow('ACTOR_DENIED');
    await db
      .getRepository('TechnicianAssignment')
      .update(f.assignment.id, { isActive: false });
    await expect(f.execute()).rejects.toThrow('ACTOR_DENIED');
    const g = await fixture();
    await db
      .getRepository('AdditionalCostRequest')
      .update(g.cost.id, { decidedByCustomerId: g.actor.id });
    expect((await g.execute()).state.reason).toBe('PARTS_SOURCE_UNVERIFIED');
  });
  it('rolls back failed journal insert and does not retain a command receipt', async () => {
    const f = await fixture();
    await expect(
      db.transaction(async (m) => {
        await store.execute(m, f.request.id, f.command, f.actor);
        throw new Error('CI rollback');
      }),
    ).rejects.toThrow('CI rollback');
    expect(await eventCount(f.request.id)).toBe(0);
    expect((await f.execute()).replayed).toBe(false);
  });
  it.each([
    'ISSUE_TO_COURIER',
    'COURIER_DISPATCH',
    'TECHNICIAN_RECEIPT',
    'RELEASE',
  ] as const)(
    'rejects %s under closed gate without recording a handoff',
    async (kind) => {
      const f = await fixture();
      await expect(
        db.transaction((m) =>
          store.execute(m, f.request.id, { ...f.command, kind }, f.actor),
        ),
      ).rejects.toThrow('ACTIVATION_CLOSED');
      expect(await eventCount(f.request.id)).toBe(0);
    },
  );
  it('DB blocks enabled gate, fabricated physical event, movement and enrolled legacy QR', async () => {
    const f = await fixture();
    await f.execute();
    await expect(
      db.query('UPDATE warehouse_delivery_gate SET enabled=true WHERE id=1'),
    ).rejects.toThrow();
    const event = await db
      .getRepository('WarehouseDeliveryEvent')
      .findOneByOrFail({ partRequestId: f.request.id });
    await expect(
      db.getRepository('WarehouseDeliveryEvent').insert({
        ...event,
        commandId: randomUUID(),
        expectedVersion: 1,
        resultVersion: 2,
        kind: 'ISSUE_TO_COURIER',
        snapshot: {
          ...event.snapshot,
          version: 2,
          status: 'ISSUED_TO_COURIER',
        },
      }),
    ).rejects.toThrow('activation closed');
    await expect(
      db.query(
        `INSERT INTO warehouse_delivery_movements(part_request_id,command_id,warehouse_id,part_id,kind,delta,reservation_delta,on_hand_after,reserved_after)
      VALUES($1,$2,$3,$4,'RESERVE',0,1,1,1)`,
        [f.request.id, f.command.commandId, randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow('Delivery movement scope mismatch');
    await expect(
      db.getRepository('PartRequest').update(f.request.id, {
        status: 'ready',
        qrToken: 'not-courier-proof',
      }),
    ).rejects.toThrow('activation closed');
  });
  it('DB rejects wrong JSON types, direct CAS gaps and physical snapshots', async () => {
    const f = await fixture();
    await f.execute();
    const event = await db
      .getRepository('WarehouseDeliveryEvent')
      .findOneByOrFail({ partRequestId: f.request.id });
    for (const snapshot of [
      { ...event.snapshot, version: '2' },
      {
        ...event.snapshot,
        version: 2,
        quantities: [{ partId: randomUUID(), quantity: 2 }],
      },
      {
        ...event.snapshot,
        version: 2,
        evidence: [{ kind: 'ISSUE_TO_COURIER', evidenceRef: 'forged' }],
      },
      { ...event.snapshot, version: 2, paid: true },
    ]) {
      await expect(
        db.getRepository('WarehouseDeliveryEvent').insert({
          ...event,
          commandId: randomUUID(),
          expectedVersion: 1,
          resultVersion: 2,
          snapshot,
        }),
      ).rejects.toThrow();
    }
    await expect(
      db.getRepository('WarehouseDeliveryEvent').insert({
        ...event,
        commandId: randomUUID(),
        expectedVersion: 3,
        resultVersion: 4,
        snapshot: { ...event.snapshot, version: 4 },
      }),
    ).rejects.toThrow('CAS conflict');
  });
  it.each([
    'warehouse_delivery_cohorts',
    'warehouse_delivery_events',
    'warehouse_delivery_movements',
    'warehouse_delivery_gate',
  ])('protects %s history and ACL/RLS', async (table) => {
    const f = await fixture();
    await f.execute();
    for (const sql of [
      `UPDATE ${table} SET ${table === 'warehouse_delivery_gate' ? 'id=id' : 'part_request_id=part_request_id'}`,
      `DELETE FROM ${table}`,
      `TRUNCATE ${table}`,
    ]) {
      // Row triggers do not run for an empty movement table. Its INSERT gate is covered above.
      if (
        table !== 'warehouse_delivery_movements' ||
        sql.startsWith('TRUNCATE')
      )
        await expect(db.query(sql)).rejects.toThrow();
    }
    expect(
      (
        await db.query(
          'SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      )[0].relrowsecurity,
    ).toBe(true);
    expect(
      await db.query(
        `SELECT acl.privilege_type FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE c.oid=$1::regclass AND acl.grantee=0`,
        [table],
      ),
    ).toHaveLength(0);
  });
  it('refuses down migration after cohort/journal enrollment', async () => {
    await fixture();
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await expect(
        new WarehouseDeliveryPhysical1793466000007().down(runner),
      ).rejects.toThrow('Refusing to discard');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  async function operationalFixture(shippingFee = 0) {
    const f = await fixture(true, true, shippingFee);
    const sm = await save('User', {
      email: `${randomUUID()}@example.test`,
      passwordHash: 'ci-no-login',
      fullName: 'CI delivery manager',
      role: Role.SERVICE_MANAGER,
      status: 'active',
      isActive: true,
    });
    const warehouse = await save('Warehouse', {
      name: 'CI independent zero-fee warehouse',
      responsibleUserId: sm.id,
      status: 'active',
    });
    await save('WarehouseStock', {
      warehouseId: warehouse.id,
      partId: f.part.id,
      onHand: 3,
      reserved: 0,
      version: 0,
    });
    // Private provider double: these tests prove PostgreSQL authority, NOT provider storage authenticity.
    const storage = {
      validate: () => {},
      upload: async (o: string, u: string) =>
        `cloudinary://evidence/fixhome/evidence/${o}/${u}/${randomUUID()}`,
      delete: async () => {},
      signedUrl: async () => 'https://example.test/private',
    };
    const runtime = createRequire(resolve('package.json'));
    const service: DeliveryOperationsService = new (runtime(
      resolve('dist/modules/part-requests/delivery-operations.service.js'),
    ).DeliveryOperationsService)(db, storage);
    const managerActor = { id: sm.id, role: Role.SERVICE_MANAGER };
    const customerActor = { id: f.customer.id, role: Role.CUSTOMER };
    const upload = async (
      purpose: string,
      actor = managerActor,
      quoteVersion = 1,
      bytes = purpose,
    ) =>
      service.upload(
        f.request.id,
        warehouse.id,
        purpose,
        quoteVersion,
        {
          buffer: Buffer.from(bytes),
          mimetype: 'image/jpeg',
          size: Buffer.byteLength(bytes),
        },
        actor,
        shippingFee > 0,
      );
    if (shippingFee > 0)
      return { ...f, service, managerActor, customerActor, warehouse, upload };
    const evidence = await upload('QUOTE');
    let proposal = await service.propose(
      f.request.id,
      {
        commandId: randomUUID(),
        expectedVersion: 0,
        warehouseId: warehouse.id,
        evidenceId: evidence.evidenceId,
        courierReference: 'ci-manual-zero',
        totalShippingFee: 0,
      },
      managerActor,
    );
    for (const actor of [customerActor, f.actor]) {
      const result = await service.consent(
        f.request.id,
        {
          commandId: randomUUID(),
          expectedVersion: proposal.version,
          quoteVersion: 1,
          quoteFingerprint: proposal.quote!.fingerprint,
          totalShippingFee: 0,
          shippingShare: 0,
          accepted: true,
        },
        actor,
      );
      proposal = { ...proposal, version: result.version };
    }
    const actual = await upload('ACTUAL');
    await service.actual(
      f.request.id,
      {
        commandId: randomUUID(),
        expectedVersion: 3,
        quoteVersion: 1,
        totalShippingFee: 0,
        evidenceId: actual.evidenceId,
      },
      managerActor,
    );
    return { ...f, service, managerActor, customerActor, warehouse, upload };
  }
  async function positiveTerms(fee = 20000) {
    const f = await operationalFixture(fee);
    const e = await f.upload('QUOTE');
    const body = {
      commandId: randomUUID(),
      expectedVersion: 0,
      warehouseId: f.warehouse.id,
      evidenceId: e.evidenceId,
      courierReference: 'ci-conditional-positive',
      totalShippingFee: fee,
    };
    const result = await f.service.recordTerms(
      f.request.id,
      'PROPOSE',
      body,
      f.managerActor,
    );
    const consent = (state: any, actor: any, extra = {}) =>
      f.service.recordTerms(
        f.request.id,
        'CONSENT',
        {
          commandId: randomUUID(),
          expectedVersion: state.version,
          quoteVersion: state.quote.quoteVersion,
          quoteFingerprint: state.quote.fingerprint,
          totalShippingFee: state.quote.totalShippingFee,
          shippingShare:
            actor.role === 'customer'
              ? state.quote.customerShippingShare
              : state.quote.technicianShippingShare,
          accepted: true,
          ...extra,
        },
        actor,
      );
    return { ...f, body, state: result.state, consent };
  }

  // The database owner is a test-fixture recorder, never a Finance approver.
  const preparation = (f: any, overrides = {}) => ({
    service_order_id: f.order.id,
    command_id: randomUUID(),
    expected_revision: 0,
    actor_user_id: f.managerActor.id,
    mandate_ref: 'preparation:unapproved-mandate',
    statement_ref: 'private-evidence:ci-d-statement',
    statement_digest: 'a'.repeat(64),
    explicit_zero: true,
    entries: [],
    ...overrides,
  });
  const appendPreparation = async (row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    return db.query(
      `INSERT INTO w3_deduction_preparations(${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      keys.map((k) => k === 'entries' ? JSON.stringify(row[k]) : row[k]),
    );
  };
  const readiness = async (id: string) =>
    (await db.query('SELECT w3_finance_readiness($1) AS result', [id]))[0].result;

  it('diagnoses missing D as unknown and recorded zero as unapproved, never finance-ready', async () => {
    const f = await positiveTerms();
    expect(await readiness(f.order.id)).toMatchObject({
      mode: 'PREPARATORY_ONLY', financialExecution: 'BLOCKED',
      commission: 'CURRENT_PREPARATION', deductionState: 'NOT_RECORDED',
      recordedDeductions: null, approvedDeductions: null, laborBudget: null,
      aggregateBudgetVerified: false,
    });
    const [row] = await appendPreparation(preparation(f));
    expect(row).toMatchObject({ revision: 1, recorded_total: '0',
      actor_role: 'service_manager', financial_execution: 'BLOCKED',
      mode: 'PREPARATORY_ONLY', verification: 'RECORDED_NOT_VERIFIED' });
    expect(row.commission_snapshot.service_order_id).toBe(f.order.id);
    expect(row.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await readiness(f.order.id)).toMatchObject({
      deductionState: 'RECORDED_UNAPPROVED', deductionRevision: 1,
      recordedDeductions: 0, approvedDeductions: null, laborBudget: null,
      financialExecution: 'BLOCKED', aggregateBudgetVerified: false,
    });
    // Neither recording D nor read-only diagnostics change the public contract.
    expect((await f.service.readTerms(f.request.id, f.customerActor)).blockers).toEqual([
      'COMMISSION_NOT_FROZEN', 'DEDUCTIONS_LEDGER_SOURCE_REQUIRED', 'SELLER_TAX_PAYMENT_POLICY_REQUIRED',
    ]);
    expect(await readiness(randomUUID())).toBeNull();
    expect(await db.getRepository('Invoice').countBy({ serviceOrderId: f.order.id })).toBe(0);
    expect(JSON.stringify(await readiness(f.order.id))).not.toMatch(/statement_ref|statement_digest|actor_user_id|mandate_ref/);
    const runner = db.createQueryRunner();
    await runner.connect(); await runner.startTransaction();
    try {
      const migration = db.migrations.find((m) => m.name === 'W3DeductionPreparation1793466000012')!;
      await expect(migration.down(runner)).rejects.toThrow('Refusing to discard W3 deduction preparation history');
    } finally { await runner.rollbackTransaction(); await runner.release(); }
  });

  it('keeps full-statement revisions immutable and serializes same-order CAS races', async () => {
    const f = await positiveTerms();
    const row = preparation(f);
    await appendPreparation(row);
    await expect(appendPreparation(row)).rejects.toThrow('W3_D_PREPARATION_CAS_CONFLICT');
    const entry = { entryId: 'deduction-1', category: 'TAX_WITHHOLDING', amount: 19,
      evidenceRef: 'private-evidence:deduction-1', contentDigest: 'b'.repeat(64) };
    const attempts = await Promise.allSettled([
      appendPreparation(preparation(f, { expected_revision: 1, explicit_zero: false, entries: [entry] })),
      appendPreparation(preparation(f, { expected_revision: 1, explicit_zero: false, entries: [{ ...entry, amount: 23 }] })),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rejected = attempts.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.message).toContain('W3_D_PREPARATION_CAS_CONFLICT');
    const rows = await db.query('SELECT * FROM w3_deduction_preparations WHERE service_order_id=$1 ORDER BY revision', [f.order.id]);
    expect(rows).toHaveLength(2);
    expect(rows[0].recorded_total).toBe('0');
    expect(['19', '23']).toContain(rows[1].recorded_total);
    const [replacement] = await appendPreparation(preparation(f, { expected_revision: 2 }));
    expect(replacement.revision).toBe(3);
    expect((await readiness(f.order.id)).recordedDeductions).toBe(0);
    expect(await db.query('SELECT revision FROM w3_deduction_preparations WHERE service_order_id=$1', [f.order.id])).toHaveLength(3);
    for (const sql of [
      'UPDATE w3_deduction_preparations SET recorded_total=recorded_total WHERE service_order_id=$1',
      'DELETE FROM w3_deduction_preparations WHERE service_order_id=$1',
    ]) await expect(db.query(sql, [f.order.id])).rejects.toThrow('append-only');
    await expect(db.query('TRUNCATE w3_deduction_preparations')).rejects.toThrow('append-only');
  });

  it('rejects malformed D, implicit zero, unapproved categories, forged approval and missing actor evidence', async () => {
    const f = await positiveTerms();
    const entry = { entryId: 'deduction-1', category: 'LABOR_ADJUSTMENT', amount: 1,
      evidenceRef: 'private-evidence:deduction-1', contentDigest: 'b'.repeat(64) };
    for (const override of [
      { explicit_zero: false }, { explicit_zero: null }, { entries: null },
      { statement_ref: '' }, { statement_digest: 'fake' }, { mandate_ref: '' },
      { actor_user_id: randomUUID() }, { expected_revision: -1 },
      { financial_execution: 'ENABLED' }, { mode: 'LIVE' }, { verification: 'FINANCE_APPROVED' },
      { explicit_zero: false, entries: [{ ...entry, category: 'COMMISSION' }] },
      { explicit_zero: false, entries: [{ ...entry, amount: 0 }] },
      { explicit_zero: false, entries: [{ ...entry, amount: 1.5 }] },
      { explicit_zero: false, entries: [{ ...entry, amount: '1' }] },
      { explicit_zero: false, entries: [{ ...entry, evidenceRef: null }] },
      { explicit_zero: false, entries: [{ ...entry, approved: true }] },
      { explicit_zero: false, entries: [entry, entry] },
      { explicit_zero: false, entries: [{ ...entry, amount: 9007199254740991 }, { ...entry, entryId: 'other' }] },
    ]) await expect(appendPreparation(preparation(f, override))).rejects.toThrow();
    expect((await readiness(f.order.id)).recordedDeductions).toBeNull();
  });

  it('marks D stale after labor drift, preserves history and refuses new preparation on stale C', async () => {
    const f = await positiveTerms();
    await appendPreparation(preparation(f));
    await db.query('UPDATE bookings SET fixed_unit_price_snapshot=100001 WHERE id=$1', [f.booking.id]);
    expect(await readiness(f.order.id)).toMatchObject({
      commission: 'STALE_PREPARATION', deductionState: 'STALE_COMMISSION',
      recordedDeductions: 0, approvedDeductions: null, financialExecution: 'BLOCKED',
    });
    await expect(appendPreparation(preparation(f, { expected_revision: 1 }))).rejects.toThrow('W3_D_PREPARATION_CURRENT_COMMISSION_REQUIRED');
    expect((await db.query('SELECT count(*)::int AS n FROM w3_deduction_preparations WHERE service_order_id=$1', [f.order.id]))[0].n).toBe(1);
  });

  it('does not create C or default D to zero when no positive conditional terms exist', async () => {
    const f = await operationalFixture();
    expect(await readiness(f.order.id)).toMatchObject({
      commission: 'NOT_RECORDED', deductionState: 'NOT_RECORDED', recordedDeductions: null,
      explicitZero: null, approvedDeductions: null, financialExecution: 'BLOCKED',
    });
    await expect(appendPreparation(preparation(f))).rejects.toThrow('W3_D_PREPARATION_CURRENT_COMMISSION_REQUIRED');
    expect((await db.query('SELECT count(*)::int AS n FROM w3_order_commission_snapshots WHERE service_order_id=$1', [f.order.id]))[0].n).toBe(0);
  });
  it('freezes approved L and versioned config C before quote, binds all terms, and refuses history rewrite/down', async () => {
    const f = await positiveTerms();
    const [snapshot] = await db.query(
      'SELECT * FROM w3_order_commission_snapshots WHERE service_order_id=$1',
      [f.order.id],
    );
    expect(snapshot).toMatchObject({
      labor_total: '100000',
      commission_amount: '10000',
      rate_bps: 1000,
    });
    expect(snapshot.labor_source.booking.id).toBe(f.booking.id);
    expect(snapshot.labor_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.config_version_id).toBeTruthy();
    const result = await f.consent(f.state, f.customerActor);
    const rows = await db.query(
      'SELECT commission_order_id FROM delivery_fee_terms WHERE part_request_id=$1',
      [f.request.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.commission_order_id === f.order.id)).toBe(true);
    expect(result.state.financialExecution).toBe('BLOCKED');
    expect((await f.service.readTerms(f.request.id, f.customerActor)).blockers).toEqual([
      'COMMISSION_NOT_FROZEN', 'DEDUCTIONS_LEDGER_SOURCE_REQUIRED', 'SELLER_TAX_PAYMENT_POLICY_REQUIRED',
    ]);
    for (const sql of [
      'UPDATE w3_order_commission_snapshots SET labor_total=labor_total',
      'DELETE FROM w3_order_commission_snapshots',
      'TRUNCATE w3_order_commission_snapshots',
      'UPDATE w3_commission_config_versions SET snapshot=snapshot',
      'TRUNCATE w3_commission_config_versions',
    ])
      await expect(db.query(sql)).rejects.toThrow();
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const migration = db.migrations.find(
        (m) => m.name === 'W3PrequoteCommission1793466000011',
      )!;
      await expect(migration.down(runner)).rejects.toThrow(
        'Refusing to discard W3 commission history',
      );
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
  it('keeps frozen C across config drift, invalidates consent/read/replay even if updated_at is preserved', async () => {
    const f = await positiveTerms();
    const [before] = await db.query(
      'SELECT * FROM w3_order_commission_snapshots WHERE service_order_id=$1',
      [f.order.id],
    );
    await db.query(
      "UPDATE system_configs SET value='2000' WHERE key='commission.rate_bps'",
    );
    try {
      expect(
        (await f.service.readTerms(f.request.id, f.customerActor)).invalidated,
      ).toBe(true);
      await expect(f.consent(f.state, f.actor)).rejects.toThrow();
      await expect(
        f.service.recordTerms(f.request.id, 'PROPOSE', f.body, f.managerActor),
      ).rejects.toThrow();
      expect(
        (
          await db.query(
            'SELECT * FROM w3_order_commission_snapshots WHERE service_order_id=$1',
            [f.order.id],
          )
        )[0],
      ).toEqual(before);
    } finally {
      await db.query(
        "UPDATE system_configs SET value='1000' WHERE key='commission.rate_bps'",
      );
    }
    // Same value and timestamp do not restore a version that has been replaced.
    expect(
      (await f.service.readTerms(f.request.id, f.customerActor)).invalidated,
    ).toBe(true);
  });
  it('rejects changed approved labor source even when total is unchanged, without replacing C', async () => {
    const f = await positiveTerms();
    await db.query('UPDATE bookings SET scope_snapshot=$1 WHERE id=$2', [
      'changed approved labor scope',
      f.booking.id,
    ]);
    expect(
      (await f.service.readTerms(f.request.id, f.customerActor)).invalidated,
    ).toBe(true);
    await expect(f.consent(f.state, f.customerActor)).rejects.toThrow();
    expect(
      (
        await db.query(
          'SELECT commission_amount FROM w3_order_commission_snapshots WHERE service_order_id=$1',
          [f.order.id],
        )
      )[0].commission_amount,
    ).toBe('10000');
  });
  it('rolls back a first quote AND its C freeze when strict audit fails', async () => {
    const f = await operationalFixture(20);
    const e = await f.upload('QUOTE');
    await db.query(`CREATE FUNCTION w3_test_fail_c_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.resource_type='delivery_fee_terms' THEN RAISE EXCEPTION 'injected C audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER w3_test_fail_c_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION w3_test_fail_c_audit()`);
    try {
      await expect(
        f.service.recordTerms(
          f.request.id,
          'PROPOSE',
          {
            commandId: randomUUID(),
            expectedVersion: 0,
            warehouseId: f.warehouse.id,
            evidenceId: e.evidenceId,
            courierReference: 'ci-c-rollback',
            totalShippingFee: 20,
          },
          f.managerActor,
        ),
      ).rejects.toThrow('injected C audit failure');
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM w3_order_commission_snapshots WHERE service_order_id=$1',
            [f.order.id],
          )
        )[0].n,
      ).toBe(0);
    } finally {
      await db.query(
        'DROP TRIGGER w3_test_fail_c_audit ON audit_logs; DROP FUNCTION w3_test_fail_c_audit()',
      );
    }
  });
  it('rejects fractional approved labor VND instead of rounding it to a commission base', async () => {
    const f = await operationalFixture(20);
    await db.query(
      'UPDATE bookings SET fixed_unit_price_snapshot=100000.50 WHERE id=$1',
      [f.booking.id],
    );
    const e = await f.upload('QUOTE');
    await expect(
      f.service.recordTerms(
        f.request.id,
        'PROPOSE',
        {
          commandId: randomUUID(),
          expectedVersion: 0,
          warehouseId: f.warehouse.id,
          evidenceId: e.evidenceId,
          courierReference: 'ci-fractional-labor',
          totalShippingFee: 20,
        },
        f.managerActor,
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM w3_order_commission_snapshots WHERE service_order_id=$1',
          [f.order.id],
        )
      )[0].n,
    ).toBe(0);
  });
  it('freezes approved inspection LABOR plus approved delta using integer half-up, excluding parts/shipping', async () => {
    const f = await operationalFixture(20);
    await db.query("UPDATE bookings SET pricing_mode_snapshot='inspection_required',fixed_unit_price_snapshot=NULL WHERE id=$1", [f.booking.id]);
    const quotation = await save('Quotation', { serviceOrderId: f.order.id, technicianId: f.actor.id,
      status: 'approved', version: 1, decidedAt: new Date(), laborTotal: 101 });
    await save('QuotationItem', { quotationId: quotation.id, type: 'labor', description: 'CI approved labor', quantity: 1, unitPrice: 101, lineTotal: 101 });
    await save('AdditionalCostItem', { requestId: f.cost.id, type: 'labor', description: 'CI approved delta', quantity: 2, unitPrice: 2, lineTotal: 4 });
    await db.query('UPDATE additional_cost_requests SET total_labor_delta=4 WHERE id=$1', [f.cost.id]);
    const e = await f.upload('QUOTE');
    await f.service.recordTerms(f.request.id, 'PROPOSE', { commandId: randomUUID(), expectedVersion: 0,
      warehouseId: f.warehouse.id, evidenceId: e.evidenceId, courierReference: 'ci-inspection-labor', totalShippingFee: 20 }, f.managerActor);
    const [snapshot] = await db.query('SELECT * FROM w3_order_commission_snapshots WHERE service_order_id=$1', [f.order.id]);
    expect(snapshot).toMatchObject({ labor_total: '105', commission_amount: '11' });
    expect(snapshot.labor_source.quotation).toMatchObject({ id: quotation.id, version: 1 });
  });
  it('serializes concurrent first positive proposals into one C freeze and one command receipt', async () => {
    const f = await operationalFixture(20);
    const e = await f.upload('QUOTE');
    const body = { commandId: randomUUID(), expectedVersion: 0, warehouseId: f.warehouse.id,
      evidenceId: e.evidenceId, courierReference: 'ci-first-freeze-race', totalShippingFee: 20 };
    const results = await Promise.all([1,2].map(() => f.service.recordTerms(f.request.id, 'PROPOSE', body, f.managerActor)));
    expect(results.filter(r => r.replayed)).toHaveLength(1);
    expect((await db.query('SELECT count(*)::int AS n FROM w3_order_commission_snapshots WHERE service_order_id=$1', [f.order.id]))[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM delivery_fee_terms WHERE part_request_id=$1', [f.request.id]))[0].n).toBe(1);
  });
  it('persists positive 70/30 terms, separate consents and lower actual without enabling financial or physical execution', async () => {
    const f = await positiveTerms();
    expect(f.state.quote).toMatchObject({
      totalShippingFee: 20000,
      customerShippingShare: 14000,
      technicianShippingShare: 6000,
    });
    expect(f.state).toMatchObject({
      laborBudget: null,
      financialExecution: 'BLOCKED',
      aggregateBudgetVerified: false,
    });
    expect(
      (
        await f.service.recordTerms(
          f.request.id,
          'PROPOSE',
          f.body,
          f.managerActor,
        )
      ).replayed,
    ).toBe(true);
    await expect(
      f.consent(f.state, f.customerActor, { accepted: false }),
    ).rejects.toThrow();
    let state = (await f.consent(f.state, f.customerActor)).state;
    expect(state.technicianConsented).toBe(false);
    const e = await f.upload('ACTUAL');
    const actual = {
      commandId: randomUUID(),
      expectedVersion: state.version,
      quoteVersion: 1,
      totalShippingFee: 18001,
      evidenceId: e.evidenceId,
    };
    await expect(
      f.service.recordTerms(
        f.request.id,
        'RECORD_ACTUAL',
        actual,
        f.managerActor,
      ),
    ).rejects.toThrow();
    state = (await f.consent(state, f.actor)).state;
    const recorded = await f.service.recordTerms(
      f.request.id,
      'RECORD_ACTUAL',
      { ...actual, expectedVersion: state.version },
      f.managerActor,
    );
    expect(recorded.state.actual).toMatchObject({
      totalShippingFee: 18001,
      customerShippingShare: 12601,
      technicianShippingShare: 5400,
      verification: 'RECORDED_NOT_EXTERNALLY_VERIFIED',
    });
    expect(recorded.state.quote).not.toHaveProperty('assignmentId');
    expect(recorded.state.quote).not.toHaveProperty('responsibleUserId');
    const revisedEvidence = await f.upload(
      'QUOTE',
      f.managerActor,
      2,
      'post-actual quote',
    );
    await expect(
      f.service.recordTerms(
        f.request.id,
        'PROPOSE',
        {
          ...f.body,
          commandId: randomUUID(),
          expectedVersion: 4,
          evidenceId: revisedEvidence.evidenceId,
        },
        f.managerActor,
      ),
    ).rejects.toMatchObject({
      response: {
        details: { blocker: 'DELIVERY_TERMS_ACTUAL_RECONCILIATION_REQUIRED' },
      },
    });
    expect(
      (await f.service.readTerms(f.request.id, f.customerActor)).invalidated,
    ).toBe(false);
    await expect(
      f.service.physical(
        f.request.id,
        'RESERVE',
        { commandId: randomUUID(), expectedVersion: 0 },
        f.actor,
      ),
    ).rejects.toThrow();
    expect(await eventCount(f.request.id)).toBe(0);
    expect(
      await db.getRepository('Invoice').countBy({ serviceOrderId: f.order.id }),
    ).toBe(0);
    expect(
      (
        await db
          .getRepository('WarehouseStock')
          .findOneByOrFail({ warehouseId: f.warehouse.id })
      ).reserved,
    ).toBe(0);
  });
  it('serializes positive terms CAS and exact-command retry, and rolls back a failed audit', async () => {
    const f = await positiveTerms();
    const race = await Promise.allSettled([
      f.consent(f.state, f.customerActor),
      f.consent(f.state, f.actor),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      (await f.service.readTerms(f.request.id, f.customerActor)).invalidated,
    ).toBe(false);
    const [prior] = await db.query(
      'SELECT *, source_snapshot=w3_fee_source_snapshot(part_request_id) AS source_current FROM delivery_fee_terms WHERE part_request_id=$1 AND command_id=$2',
      [f.request.id, f.body.commandId],
    );
    expect(prior.source_current).toBe(true);
    expect(prior.state.quote.responsibleUserId).toBe(f.managerActor.id);
    expect(prior.state.quote.assignmentId).toBe(f.assignment.id);
    const retry = await Promise.all([
      f.service.recordTerms(f.request.id, 'PROPOSE', f.body, f.managerActor),
      f.service.recordTerms(f.request.id, 'PROPOSE', f.body, f.managerActor),
    ]);
    expect(retry.every((r) => r.replayed)).toBe(true);
    const g = await positiveTerms();
    await db.query(`CREATE FUNCTION w3_test_fail_terms_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.resource_type='delivery_fee_terms' THEN RAISE EXCEPTION 'injected terms audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER w3_test_fail_terms_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION w3_test_fail_terms_audit()`);
    try {
      await expect(g.consent(g.state, g.customerActor)).rejects.toThrow(
        'injected terms audit failure',
      );
    } finally {
      await db.query(
        'DROP TRIGGER w3_test_fail_terms_audit ON audit_logs; DROP FUNCTION w3_test_fail_terms_audit()',
      );
    }
    expect(
      (await g.service.readTerms(g.request.id, g.customerActor)).state.version,
    ).toBe(1);
  });
  it('invalidates stale source/assignment, rejects forged source, actual over ceiling, and keeps immutable history', async () => {
    const f = await positiveTerms();
    let state = (await f.consent(f.state, f.customerActor)).state;
    state = (await f.consent(state, f.actor)).state;
    const e = await f.upload('ACTUAL');
    await expect(
      f.service.recordTerms(
        f.request.id,
        'RECORD_ACTUAL',
        {
          commandId: randomUUID(),
          expectedVersion: 3,
          quoteVersion: 1,
          totalShippingFee: 20001,
          evidenceId: e.evidenceId,
        },
        f.managerActor,
      ),
    ).rejects.toThrow();
    await db
      .getRepository('AdditionalCostRequest')
      .update(f.cost.id, { reason: 'CI source change' });
    expect(
      (await f.service.readTerms(f.request.id, f.customerActor)).invalidated,
    ).toBe(true);
    await expect(
      f.service.recordTerms(f.request.id, 'PROPOSE', f.body, f.managerActor),
    ).rejects.toThrow();
    for (const sql of [
      'UPDATE delivery_fee_terms SET state=state',
      'DELETE FROM delivery_fee_terms',
      'TRUNCATE delivery_fee_terms',
    ])
      await expect(db.query(sql)).rejects.toThrow();
    expect(
      (
        await db.query(
          "SELECT relrowsecurity FROM pg_class WHERE oid='delivery_fee_terms'::regclass",
        )
      )[0].relrowsecurity,
    ).toBe(true);
  });
  it('revises pre-actual terms with fresh evidence and clears both prior consents; per-delivery S=1 keeps c=1,t=0', async () => {
    const f = await positiveTerms(1);
    expect(f.state.quote).toMatchObject({
      customerShippingShare: 1,
      technicianShippingShare: 0,
    });
    const state = (await f.consent(f.state, f.customerActor)).state;
    const e = await f.upload('QUOTE', f.managerActor, 2, 'new quote bytes');
    const revised = await f.service.recordTerms(
      f.request.id,
      'PROPOSE',
      {
        ...f.body,
        commandId: randomUUID(),
        expectedVersion: state.version,
        evidenceId: e.evidenceId,
      },
      f.managerActor,
    );
    expect(revised.state).toMatchObject({
      customerConsented: false,
      technicianConsented: false,
      actual: null,
    });
    expect(revised.state.quote.quoteVersion).toBe(2);
    await expect(
      f.consent(revised.state, f.actor, {
        quoteFingerprint: f.state.quote.fingerprint,
      }),
    ).rejects.toThrow();
  });
  it('sums per-delivery stored conditional ceilings under the order lock without claiming a verified labor budget', async () => {
    const f = await positiveTerms(1);
    const cost = await save('AdditionalCostRequest', {
      serviceOrderId: f.order.id,
      technicianId: f.actor.id,
      reason: 'CI independent sibling shipping source',
      status: 'approved',
      decidedAt: new Date(),
      decidedByCustomerId: f.customer.id,
      expiresAt: new Date(Date.now() + 86400000),
      fulfillmentMethod: 'delivery',
      shippingFee: 1,
    });
    await save('AdditionalCostItem', {
      requestId: cost.id,
      type: 'parts_equipment',
      description: 'CI sibling part',
      partSource: 'fixhome',
      partCatalogId: f.part.id,
      quantity: 2,
      unitPrice: 1000,
      lineTotal: 2000,
    });
    const sibling = await db.transaction(async (m) => {
      const r = await m
        .getRepository('PartRequest')
        .save({
          serviceOrderId: f.order.id,
          technicianId: f.actor.id,
          requestType: 'additional',
          fulfillmentMethod: 'delivery',
          additionalCostId: cost.id,
          shippingFee: 1,
        });
      await m
        .getRepository('PartRequestItem')
        .save({
          partRequestId: r.id,
          partCatalogId: f.part.id,
          partSource: 'fixhome',
          partNameSnapshot: 'CI sibling part',
          quantity: 2,
          unitPriceSnapshot: 1000,
        });
      await store.enrollNew(m, r.id, f.actor);
      return r;
    });
    const evidence = await f.service.upload(
      sibling.id,
      f.warehouse.id,
      'QUOTE',
      1,
      { buffer: Buffer.from('sibling'), size: 7, mimetype: 'image/jpeg' },
      f.managerActor,
      true,
    );
    await f.service.recordTerms(
      sibling.id,
      'PROPOSE',
      { ...f.body, commandId: randomUUID(), evidenceId: evidence.evidenceId },
      f.managerActor,
    );
    const summary = await f.service.readTerms(f.request.id, f.customerActor);
    expect(summary.recordedConditionalCeilings).toEqual({
      count: 2,
      shipping: '2',
      customer: '2',
      technician: '0',
    });
    expect(summary).toMatchObject({
      laborBudget: null,
      aggregateBudgetVerified: false,
      financialExecution: 'BLOCKED',
    });
    await db
      .getRepository('PartRequest')
      .update(sibling.id, { status: 'cancelled' });
    // Cancellation is not proof of financial release; recorded terms stay visible in the summary.
    expect(
      (await f.service.readTerms(f.request.id, f.customerActor))
        .recordedConditionalCeilings,
    ).toEqual(summary.recordedConditionalCeilings);
  });

  it('keeps source fingerprints identical across PostgreSQL session timezones', async () => {
    const f = await positiveTerms();
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      for (const zone of ['UTC', 'Asia/Ho_Chi_Minh']) {
        await runner.query(`SET TIME ZONE '${zone}'`);
        expect(
          (
            await runner.query(
              'SELECT source_snapshot=w3_fee_source_snapshot(part_request_id) AS same FROM delivery_fee_terms WHERE part_request_id=$1',
              [f.request.id],
            )
          )[0].same,
        ).toBe(true);
      }
    } finally {
      await runner.query("SET TIME ZONE 'UTC'");
      await runner.release();
    }
  });
  it('requires a same-transaction strict audit and rejects direct body/verdict injection', async () => {
    const f = await positiveTerms();
    const e = await f.upload('QUOTE', f.managerActor, 2, 'direct SQL quote');
    const body = {
      ...f.body,
      commandId: randomUUID(),
      expectedVersion: 1,
      evidenceId: e.evidenceId,
    };
    const insert = (payload: object) =>
      db.query(
        `INSERT INTO delivery_fee_terms
      (part_request_id,service_order_id,command_id,expected_version,actor_user_id,actor_role,kind,command_body,state)
      VALUES ($1,$2,$3,1,$4,'service_manager','PROPOSE',$5::jsonb,'{"financialExecution":"ALLOWED"}'::jsonb)`,
        [
          f.request.id,
          f.order.id,
          body.commandId,
          f.managerActor.id,
          JSON.stringify(payload),
        ],
      );
    await expect(
      insert({ ...body, budget: { knownApprovedDeductions: 0 } }),
    ).rejects.toThrow('DELIVERY_TERMS_INVALID_COMMAND');
    await expect(insert(body)).rejects.toThrow(
      'DELIVERY_TERMS_STRICT_AUDIT_REQUIRED',
    );
    expect(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM delivery_fee_terms WHERE part_request_id=$1',
          [f.request.id],
        )
      )[0].n,
    ).toBe(1);
    await expect(
      db.query(
        "UPDATE audit_logs SET action='forged' WHERE resource_type='delivery_fee_terms'",
      ),
    ).rejects.toThrow('audit is immutable');
  });
  it('enforces real HTTP/JWT/current DB role, DTO and ownership for positive fee terms', async () => {
    const f = await positiveTerms();
    const runtime = createRequire(resolve('package.json'));
    const Controller = runtime(
      resolve('dist/modules/part-requests/delivery-operations.controller.js'),
    ).DeliveryOperationsController;
    const Service = runtime(
      resolve('dist/modules/part-requests/delivery-operations.service.js'),
    ).DeliveryOperationsService;
    const Strategy = runtime(
      resolve('dist/modules/auth/strategies/jwt.strategy.js'),
    ).JwtStrategy;
    const UserEntity = runtime(
      resolve('dist/modules/users/entities/user.entity.js'),
    ).User;
    const signingKey = randomUUID(); // Ephemeral isolated test key, never a provider credential.
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: signingKey })],
      controllers: [Controller],
      providers: [
        Strategy,
        { provide: Service, useValue: f.service },
        { provide: ConfigService, useValue: { getOrThrow: () => signingKey } },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: db.getRepository('User'),
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    const token = (id: string, role = Role.ADMIN) =>
      module.get(JwtService).sign({ sub: id, role });
    const path = `/api/v1/part-requests/${f.request.id}/delivery/terms`;
    const outsider = await save('User', {
      email: `${randomUUID()}@example.test`,
      passwordHash: 'ci-no-login',
      fullName: 'CI other customer',
      role: Role.CUSTOMER,
      status: 'active',
      isActive: true,
    });
    const admin = await save('User', {
      email: `${randomUUID()}@example.test`,
      passwordHash: 'ci-no-login',
      fullName: 'CI terms admin',
      role: Role.ADMIN,
      status: 'active',
      isActive: true,
    });
    try {
      await request(app.getHttpServer()).get(path).expect(401);
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token(admin.id, Role.CUSTOMER)}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token(outsider.id)}`)
        .expect(404);
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token(f.customer.id)}`)
        .expect(200)
        .expect('Cache-Control', 'no-store');
      const body = {
        commandId: randomUUID(),
        expectedVersion: 1,
        quoteVersion: 1,
        quoteFingerprint: f.state.quote.fingerprint,
        totalShippingFee: 20000,
        shippingShare: 14000,
        accepted: true,
      };
      await request(app.getHttpServer())
        .post(`${path}/consent`)
        .set('Authorization', `Bearer ${token(f.customer.id)}`)
        .send({ ...body, actorId: f.actor.id, budget: { laborTotal: 100000 } })
        .expect(400);
      await request(app.getHttpServer())
        .post(`${path}/proposal`)
        .set(
          'Authorization',
          `Bearer ${token(f.customer.id, Role.SERVICE_MANAGER)}`,
        )
        .send(f.body)
        .expect(403);
      await request(app.getHttpServer())
        .post(`${path}/consent`)
        .set('Authorization', `Bearer ${token(f.customer.id)}`)
        .send(body)
        .expect(201);
      await db
        .getRepository('User')
        .update(f.customer.id, { status: 'locked' });
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token(f.customer.id)}`)
        .expect(401);
    } finally {
      await app.close();
    }
  });
  it('operates zero-fee reservation, courier issue/dispatch and technician receipt with DB-owned deltas', async () => {
    const f = await operationalFixture();
    const body = { commandId: randomUUID(), expectedVersion: 0 };
    await f.service.physical(f.request.id, 'RESERVE', body, f.actor);
    expect(
      (await f.service.physical(f.request.id, 'RESERVE', body, f.actor))
        .replayed,
    ).toBe(true);
    for (const [i, kind] of [
      'ISSUE_TO_COURIER',
      'COURIER_DISPATCH',
      'TECHNICIAN_RECEIPT',
    ].entries()) {
      const actor = i === 2 ? f.actor : f.managerActor;
      const e = await f.upload(kind, actor);
      await f.service.physical(
        f.request.id,
        kind as any,
        {
          commandId: randomUUID(),
          expectedVersion: i + 1,
          evidenceId: e.evidenceId,
        },
        actor,
      );
    }
    expect(
      (await f.service.read(f.request.id, f.customerActor)).physical?.status,
    ).toBe('TECHNICIAN_RECEIVED');
    expect(
      await db.query(
        'SELECT on_hand,reserved FROM warehouse_stock WHERE warehouse_id=$1',
        [f.warehouse.id],
      ),
    ).toEqual([{ on_hand: 1, reserved: 0 }]);
    expect(
      await db.query(
        'SELECT * FROM warehouse_delivery_movements WHERE part_request_id=$1',
        [f.request.id],
      ),
    ).toHaveLength(2);
    await expect(
      db.query(
        "UPDATE part_requests SET status='received',received_at=now() WHERE id=$1",
        [f.request.id],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "UPDATE part_request_items SET usage_status='used' WHERE part_request_id=$1",
        [f.request.id],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        'UPDATE service_orders SET completion_requested_at=now() WHERE id=$1',
        [f.order.id],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        'UPDATE additional_cost_items SET quantity=3 WHERE request_id=$1',
        [f.cost.id],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        'UPDATE technician_assignments SET is_active=false WHERE id=$1',
        [f.assignment.id],
      ),
    ).rejects.toThrow();
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await expect(
        new DeliveryZeroFeeOperations1793466000008().down(runner),
      ).rejects.toThrow('Refusing to discard');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
  it('serializes live reservation CAS across connections without issuing stock twice', async () => {
    const f = await operationalFixture();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        f.service.physical(
          f.request.id,
          'RESERVE',
          { commandId: randomUUID(), expectedVersion: 0 },
          f.actor,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({
      status: 409,
      response: { details: { blocker: 'DELIVERY_CAS_CONFLICT' } },
    });
    expect(
      await db.query(
        'SELECT on_hand,reserved FROM warehouse_stock WHERE warehouse_id=$1',
        [f.warehouse.id],
      ),
    ).toEqual([{ on_hand: 3, reserved: 2 }]);
    await f.service.physical(
      f.request.id,
      'RELEASE',
      { commandId: randomUUID(), expectedVersion: 1 },
      f.managerActor,
    );
    expect(
      await db.query(
        'SELECT on_hand,reserved FROM warehouse_stock WHERE warehouse_id=$1',
        [f.warehouse.id],
      ),
    ).toEqual([{ on_hand: 3, reserved: 0 }]);
  });
  it('rejects forged reservation receipts without applying stock deltas or completing the movement journal', async () => {
    const f = await operationalFixture();
    const event = (commandId: string) => ({
      partRequestId: f.request.id,
      commandId,
      actorUserId: f.actor.id,
      actorRole: f.actor.role,
      kind: 'RESERVE',
      expectedVersion: 0,
      resultVersion: 1,
      fingerprint: 'a'.repeat(64),
      snapshot: {
        version: 1,
        status: 'RESERVED',
        reason: null,
        warehouseId: f.warehouse.id,
        responsibleUserId: f.managerActor.id,
        quantities: [{ partId: f.part.id, quantity: 2 }],
        courierReference: null,
        evidence: [],
      },
    });
    await expect(
      db.transaction((m) =>
        m.getRepository('WarehouseDeliveryEvent').insert(event(randomUUID())),
      ),
    ).rejects.toThrow('Incomplete delivery movement journal');
    const commandId = randomUUID();
    await expect(
      db.transaction(async (m) => {
        await m
          .getRepository('WarehouseDeliveryEvent')
          .insert(event(commandId));
        await m.query(
          `INSERT INTO warehouse_delivery_movements(part_request_id,command_id,warehouse_id,part_id,kind,delta,reservation_delta,on_hand_after,reserved_after)
        VALUES($1,$2,$3,$4,'RESERVE',0,2,3,0)`,
          [f.request.id, commandId, f.warehouse.id, f.part.id],
        );
      }),
    ).rejects.toThrow('Delivery stock balance mismatch');
    expect(await eventCount(f.request.id)).toBe(0);
    expect(
      await db.query(
        'SELECT on_hand,reserved FROM warehouse_stock WHERE warehouse_id=$1',
        [f.warehouse.id],
      ),
    ).toEqual([{ on_hand: 3, reserved: 0 }]);
  });
});
