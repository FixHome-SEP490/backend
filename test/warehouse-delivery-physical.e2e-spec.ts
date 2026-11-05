// Existing ephemeral CI PostgreSQL ONLY. No dotenv/DATABASE_* or shared DEV fallback.
import 'reflect-metadata';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
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

  async function fixture(enroll = true, automatic = false) {
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
          0,
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

  async function operationalFixture() {
    const f = await fixture(true, true);
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
    const upload = async (purpose: string, actor = managerActor) =>
      service.upload(
        f.request.id,
        warehouse.id,
        purpose,
        1,
        {
          buffer: Buffer.from(purpose),
          mimetype: 'image/jpeg',
          size: Buffer.byteLength(purpose),
        },
        actor,
      );
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
