// Existing ephemeral CI PostgreSQL ONLY. No dotenv/DATABASE_* or shared DEV fallback.
import 'reflect-metadata';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import type { WarehouseDeliveryStore } from '../src/modules/part-requests/warehouse-delivery-store.service';
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

  async function fixture(enroll = true) {
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
    return { request, actor, command, execute, assignment, cost, order };
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
    ).rejects.toThrow('activation closed');
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
});
