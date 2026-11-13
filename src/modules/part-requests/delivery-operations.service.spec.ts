import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DeliveryOperationsService } from './delivery-operations.service';
import { Role } from '../../shared/enums';

// Transactional persistence double: real consent domain/store and stock writer, no provider/PG claims.
function fixture() {
  const tables = new Map<string, any[]>();
  const rows = (type: any) => {
    const key = typeof type === 'string' ? type : type.name;
    if (!tables.has(key)) tables.set(key, []);
    return tables.get(key)!;
  };
  const seed = (type: string, row: any) => {
    rows(type).push(row);
    return row;
  };
  const cap = seed('SystemConfig', {
    key: 'w3.shipping.max_new_fee_vnd', value: '20000', valueType: 'int',
  });
  const user = (role: Role) =>
    seed('User', { id: randomUUID(), role, isActive: true, status: 'active' });
  const customer = user(Role.CUSTOMER),
    tech = user(Role.TECHNICIAN),
    sm = user(Role.SERVICE_MANAGER);
  const booking = seed('Booking', {
    id: randomUUID(),
    customerId: customer.id,
  });
  const order = seed('ServiceOrder', {
    id: randomUUID(),
    bookingId: booking.id,
    status: 'under_repair',
  });
  const assignment = seed('TechnicianAssignment', {
    id: randomUUID(),
    serviceOrderId: order.id,
    technicianId: tech.id,
    isActive: true,
  });
  const cost = seed('AdditionalCostRequest', {
    id: randomUUID(),
    serviceOrderId: order.id,
    technicianId: tech.id,
    status: 'approved',
    decidedAt: new Date(),
    decidedByCustomerId: customer.id,
    fulfillmentMethod: 'delivery',
    shippingFee: 0,
  });
  const request = seed('PartRequest', {
    id: randomUUID(),
    serviceOrderId: order.id,
    technicianId: tech.id,
    requestType: 'additional',
    additionalCostId: cost.id,
    quotationId: null,
    fulfillmentMethod: 'delivery',
    shippingFee: 0,
    status: 'requested',
  });
  const warehouse = seed('Warehouse', {
    id: randomUUID(),
    responsibleUserId: sm.id,
    status: 'active',
  });
  const stocks = [1, 2]
    .map(() => {
      const partId = randomUUID();
      seed('PartRequestItem', {
        id: randomUUID(),
        partRequestId: request.id,
        partCatalogId: partId,
        partSource: 'fixhome',
        quantity: 2,
      });
      seed('AdditionalCostItem', {
        id: randomUUID(),
        requestId: cost.id,
        type: 'parts_equipment',
        partCatalogId: partId,
        partSource: 'fixhome',
        quantity: 2,
      });
      return { warehouseId: warehouse.id, partId, onHand: 3, reserved: 0 };
    })
    .sort((a, b) => a.partId.localeCompare(b.partId));
  const movements: any[] = [];
  const matches = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([k, v]: any) =>
      v?._type === 'isNull' ? row[k] == null : row[k] === v,
    );
  const manager: any = {
    queryRunner: { isTransactionActive: true },
    find: vi.fn(async (type, options) => {
      let found = rows(type).filter((r) => matches(r, options?.where));
      for (const [k, dir] of Object.entries(options?.order ?? {}))
        found = [...found].sort(
          (a, b) =>
            (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) *
            (dir === 'DESC' ? -1 : 1),
        );
      return structuredClone(found);
    }),
    findOne: async (type: any, options: any) =>
      (await manager.find(type, options))[0] ?? null,
    findOneOrFail: async (type: any, options: any) => {
      const row = await manager.findOne(type, options);
      if (!row) throw new Error('missing fixture row');
      return row;
    },
    insert: vi.fn(async (type, row) => {
      rows(type).push(structuredClone(row));
    }),
    update: async (type: any, where: any, value: any) => {
      const row = rows(type).find((r) => matches(r, where));
      if (!row) return { affected: 0 };
      Object.assign(row, structuredClone(value));
      return { affected: 1 };
    },
    query: vi.fn(async (sql: string, args: any[]) => {
      if (sql.startsWith('INSERT INTO delivery_fee_terms'))
        return [{ state: { version: 1, financialExecution: 'BLOCKED' } }];
      if (sql.includes('SELECT enabled')) return [{ enabled: false }];
      if (sql.includes('FROM delivery_shipping_proposals'))
        return rows('DeliveryShippingProposal').length
          ? [{ admitted: true }]
          : [];
      if (sql.includes('warehouse_delivery_cohorts'))
        return [
          {
            part_request_id: request.id,
            service_order_id: order.id,
            technician_id: tech.id,
          },
        ];
      if (sql.includes('SELECT part_id FROM warehouse_delivery_movements'))
        return movements
          .filter((r) => r.commandId === args[1])
          .map((r) => ({ part_id: r.partId }));
      if (sql.includes('sum(reservation_delta)'))
        return stocks.map((s) => ({
          partId: s.partId,
          reserved: movements
            .filter((r) => r.partId === s.partId)
            .reduce((n, r) => n + r.reservationDelta, 0),
          issued: movements.some(
            (r) => r.partId === s.partId && r.kind === 'ISSUE_TO_COURIER',
          ),
        }));
      if (sql.includes('FROM warehouse_stock')) return structuredClone(stocks);
      if (sql.startsWith('UPDATE warehouse_stock')) {
        Object.assign(
          stocks.find((s) => s.partId === args[1])!,
          { onHand: args[2], reserved: args[3] },
        );
      }
      if (sql.startsWith('INSERT INTO warehouse_delivery_movements')) {
        const stock = stocks.find((s) => s.partId === args[3])!;
        if (
          stock.onHand + args[5] !== args[7] ||
          stock.reserved + args[6] !== args[8]
        )
          throw new Error('movement delta mismatch');
        Object.assign(stock, { onHand: args[7], reserved: args[8] });
        movements.push({
          commandId: args[1],
          partId: args[3],
          kind: args[4],
          delta: args[5],
          reservationDelta: args[6],
        });
      }
      return [];
    }),
  };
  const storage: any = {
    validate: vi.fn(),
    upload: vi.fn(
      async (o, u) =>
        `cloudinary://evidence/fixhome/evidence/${o}/${u}/${randomUUID()}`,
    ),
    signedUrl: vi.fn(async () => 'https://example.test/private'),
    delete: vi.fn(),
  };
  const db: any = {
    transaction: async (fn: any) => {
      const backup = structuredClone([...tables]),
        stockBackup = structuredClone(stocks),
        movementBackup = structuredClone(movements);
      try {
        return await fn(manager);
      } catch (e) {
        tables.clear();
        for (const [k, v] of backup) tables.set(k, v);
        stocks.splice(0, stocks.length, ...stockBackup);
        movements.splice(0, movements.length, ...movementBackup);
        throw e;
      }
    },
  };
  const service = new DeliveryOperationsService(db, storage);
  const actor = (u: any) => ({ id: u.id, role: u.role });
  const upload = async (
    purpose: string,
    u = sm,
    version = 1,
    bytes = purpose,
  ) =>
    service.upload(
      request.id,
      warehouse.id,
      purpose,
      version,
      {
        buffer: Buffer.from(bytes),
        size: Buffer.byteLength(bytes),
        mimetype: 'image/jpeg',
      },
      actor(u),
    );
  const propose = async (version = 0) => {
    const e = await upload('QUOTE', sm, version ? 2 : 1);
    return service.propose(
      request.id,
      {
        commandId: randomUUID(),
        expectedVersion: version,
        warehouseId: warehouse.id,
        evidenceId: e.evidenceId,
        courierReference: 'manual-zero-quote',
        totalShippingFee: 0,
      },
      actor(sm),
    );
  };
  const sign = async (state: any, u: any) =>
    service.consent(
      request.id,
      {
        commandId: randomUUID(),
        expectedVersion: state.version,
        quoteVersion: state.quote.quoteVersion,
        quoteFingerprint: state.quote.fingerprint,
        totalShippingFee: 0,
        shippingShare: 0,
        accepted: true,
      },
      actor(u),
    );
  const ready = async () => {
    let r = await propose();
    r = await sign(r, customer);
    r = await sign(r, tech);
    const e = await upload('ACTUAL');
    await service.actual(
      request.id,
      {
        commandId: randomUUID(),
        expectedVersion: r.version,
        quoteVersion: 1,
        totalShippingFee: 0,
        evidenceId: e.evidenceId,
      },
      actor(sm),
    );
  };
  return {
    service,
    manager,
    rows,
    request,
    order,
    cost,
    assignment,
    warehouse,
    customer,
    tech,
    sm,
    stocks,
    movements,
    storage,
    actor,
    upload,
    propose,
    sign,
    ready,
    cap,
  };
}

describe('conditional positive shipping terms (no financial authority)', () => {
  it('uses confirmed canonical positive terms for physical reserve without a legacy proposal', async () => {
    const f = fixture();
    f.cost.shippingFee = f.request.shippingFee = 20000;
    const terms = { result_version: 4, source_current: true, state: {
      version: 4, customerConsented: true, technicianConsented: true,
      quote: { quoteVersion: 1, totalShippingFee: 20000, warehouseId: f.warehouse.id,
        responsibleUserId: f.sm.id, assignmentId: f.assignment.id, courierReference: 'positive', },
      actual: { quoteVersion: 1, totalShippingFee: 18000 },
    }};
    const original = f.manager.query.getMockImplementation()!;
    f.manager.query.mockImplementation(async (sql: string, args: any[]) => {
      if (sql.includes('FROM delivery_fee_terms')) return [terms];
      if (sql.includes('admitted') && sql.includes('warehouse_delivery_events')) return [{ admitted: true }];
      if (sql.includes('w3_positive_physical_terms')) return [{ state: terms.state }];
      return original(sql, args);
    });
    const r = await f.service.physical(f.request.id, 'RESERVE', {commandId: randomUUID(), expectedVersion: 0}, f.actor(f.tech));
    expect(r.state.status).toBe('RESERVED');
    expect(f.movements).toHaveLength(2);
    expect(f.rows('WarehouseDeliveryEvent')[0].feeTermsVersion).toBe(4);
    expect(f.rows('DeliveryShippingProposal')).toHaveLength(0);
  });
  it('read projects the paid terms so the web panel can operate a paid request (13/11)', async () => {
    const f = fixture();
    f.cost.shippingFee = f.request.shippingFee = 20000;
    const terms = { result_version: 5, source_current: true, state: {
      version: 5, customerConsented: true, technicianConsented: true,
      quote: { quoteVersion: 2, fingerprint: 'a'.repeat(64), policyVersion: 'W3_70_30_V1', totalShippingFee: 20000, customerShippingShare: 14000, technicianShippingShare: 6000,
        warehouseId: f.warehouse.id, responsibleUserId: f.sm.id, assignmentId: f.assignment.id, courierReference: 'positive' },
      actual: { quoteVersion: 2, totalShippingFee: 18000, customerShippingShare: 12600, technicianShippingShare: 5400 },
    }};
    const original = f.manager.query.getMockImplementation()!;
    f.manager.query.mockImplementation(async (sql: string, args: any[]) => {
      if (sql.includes('FROM delivery_fee_terms')) return [terms];
      return original(sql, args);
    });
    const r = await f.service.read(f.request.id, f.actor(f.customer));
    expect(r).toMatchObject({ version: 5, invalidated: false, customerConsented: true, technicianConsented: true,
      quote: { quoteVersion: 2, totalShippingFee: 20000, customerShippingShare: 14000, technicianShippingShare: 6000, laborBudget: 'UNVERIFIED' },
      actual: { totalShippingFee: 18000, quoteVersion: 2 } });
    expect(JSON.stringify(r.quote)).not.toContain(f.warehouse.id);
  });
  const proposal = (f: ReturnType<typeof fixture>, extra = {}) => ({
    commandId: randomUUID(),
    expectedVersion: 0,
    warehouseId: f.warehouse.id,
    evidenceId: randomUUID(),
    courierReference: 'conditional-courier-quote',
    totalShippingFee: 20_000,
    ...extra,
  });
  it.each(['0', '19999', '-1', '20000x', '9007199254740992'])('blocks NEW positive terms at cap %s without rewriting the approved fee', async (value) => {
    const f = fixture();
    f.cap.value = value;
    f.cost.shippingFee = f.request.shippingFee = 20000;
    const e = await f.upload('QUOTE');
    await expect(f.service.recordTerms(f.request.id, 'PROPOSE', proposal(f, { evidenceId: e.evidenceId }), f.actor(f.sm)))
      .rejects.toMatchObject({ status: 409, response: { details: { blocker: 'W3_SHIPPING_CAP_EXCEEDED' } } });
    expect(f.cost.shippingFee).toBe(20000);
    expect(f.request.shippingFee).toBe(20000);
    expect(f.rows('AuditLog')).toHaveLength(0);
    expect(f.movements).toHaveLength(0);
  });
  it.each(['missing', 'wrong type'])('fails closed with %s cap', async (mode) => {
    const f = fixture();
    if (mode === 'missing') f.rows('SystemConfig').splice(0);
    else f.cap.valueType = 'string';
    f.cost.shippingFee = f.request.shippingFee = 20000;
    const e = await f.upload('QUOTE');
    await expect(f.service.recordTerms(f.request.id, 'PROPOSE', proposal(f, { evidenceId: e.evidenceId }), f.actor(f.sm)))
      .rejects.toMatchObject({ response: { details: { blocker: 'W3_SHIPPING_CAP_EXCEEDED' } } });
  });
  it('records only server-bound approved terms, without fabricating L/C/D or stock authority', async () => {
    const f = fixture();
    f.cost.shippingFee = f.request.shippingFee = 20_000;
    const e = await f.upload('QUOTE');
    const body = proposal(f, { evidenceId: e.evidenceId });
    const original = f.manager.query.getMockImplementation()!;
    const state = {
      financialExecution: 'BLOCKED',
      laborBudget: null,
      version: 1,
    };
    f.manager.query.mockImplementation(async (sql: string, args: any[]) =>
      sql.startsWith('INSERT INTO delivery_fee_terms')
        ? [{ state }]
        : original(sql, args),
    );
    const result = await f.service.recordTerms(
      f.request.id,
      'PROPOSE',
      body,
      f.actor(f.sm),
    );
    expect(result).toMatchObject({ state, replayed: false });
    expect(
      f.manager.query.mock.calls.find(([sql]: any) =>
        sql.startsWith('INSERT INTO delivery_fee_terms'),
      )?.[1],
    ).toEqual(
      expect.arrayContaining([
        f.request.id,
        f.order.id,
        f.sm.id,
        'service_manager',
        'PROPOSE',
      ]),
    );
    expect(f.rows('DeliveryConsentCommandRecord')).toHaveLength(0);
    expect(f.movements).toHaveLength(0);
  });
  it.each(['customer', 'tech'] as const)(
    'denies %s proposing terms before journal insertion',
    async (role) => {
      const f = fixture();
      await expect(
        f.service.recordTerms(
          f.request.id,
          'PROPOSE',
          proposal(f),
          f.actor(f[role]),
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        f.manager.query.mock.calls.some(([sql]: any) =>
          sql.startsWith('INSERT INTO delivery_fee_terms'),
        ),
      ).toBe(false);
    },
  );
  it.each([null, false, '20000x', -1, 0])(
    'does not infer approved positive shipping from %s',
    async (fee) => {
      const f = fixture();
      f.cost.shippingFee = fee as any;
      await expect(
        f.service.recordTerms(
          f.request.id,
          'PROPOSE',
          proposal(f),
          f.actor(f.sm),
        ),
      ).rejects.toMatchObject({ status: 409 });
    },
  );
  it('rejects actor, budget and execution verdict injection', async () => {
    const f = fixture();
    await expect(
      f.service.recordTerms(
        f.request.id,
        'PROPOSE',
        proposal(f, {
          budget: { laborTotal: 100000 },
          financialExecution: 'ALLOWED',
        }),
        f.actor(f.sm),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('keeps SQL failures visible and does not turn them into approval or empty terms', async () => {
    const f = fixture();
    f.manager.query.mockRejectedValue(new Error('database unavailable'));
    await expect(
      f.service.readTerms(f.request.id, f.actor(f.customer)),
    ).rejects.toThrow('database unavailable');
  });
});

describe('authenticated delivery operations admission', () => {
  it('golden approved 30000 shipping remains physically blocked even with an explicit 30000 cap', async () => {
    const f = fixture();
    f.cap.value = '30000';
    f.cost.shippingFee = f.request.shippingFee = 30_000;
    const evidence = await f.upload('QUOTE');
    await expect(f.service.propose(f.request.id, {
      commandId: randomUUID(),
      expectedVersion: 0,
      warehouseId: f.warehouse.id,
      evidenceId: evidence.evidenceId,
      courierReference: 'capstone-approved-30000',
      totalShippingFee: 30_000,
    }, f.actor(f.sm))).rejects.toMatchObject({
      status: 409,
      response: { details: { blocker: 'FINANCE_LEDGER_SOURCE_REQUIRED' } },
    });
    expect(f.rows('DeliveryShippingProposal')).toHaveLength(0);
    expect(f.rows('DeliveryConsentCommandRecord')).toHaveLength(0);
    expect(f.rows('WarehouseDeliveryEvent')).toHaveLength(0);
    expect(f.movements).toHaveLength(0);
    expect(f.stocks.map(({ onHand, reserved }) => ({ onHand, reserved })))
      .toEqual([{ onHand: 3, reserved: 0 }, { onHand: 3, reserved: 0 }]);
  });

  it.each(['cost', 'request'] as const)(
    'does not consume local zero spending as aggregate authority when %s has positive shipping',
    async (source) => {
      const f = fixture();
      f[source].shippingFee = 20_000;
      await expect(f.propose()).rejects.toMatchObject({
        status: 409,
        response: { details: { blocker: 'FINANCE_LEDGER_SOURCE_REQUIRED' } },
      });
      expect(f.rows('DeliveryConsentCommandRecord')).toHaveLength(0);
      expect(f.rows('DeliveryShippingProposal')).toHaveLength(0);
      expect(f.movements).toHaveLength(0);
    },
  );
  it.each(['0', '20000'])('keeps positive operations blocked at cap %s, including below-cap fees', async (cap) => {
    const f = fixture();
    f.cap.value = cap;
    const service = f.service;
    const actor = f.actor(f.sm);
    await expect(
      service.propose(
        f.request.id,
        {
          commandId: randomUUID(),
          expectedVersion: 0,
          warehouseId: f.warehouse.id,
          evidenceId: randomUUID(),
          courierReference: 'positive-quote',
          totalShippingFee: 1,
        },
        actor,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { details: { blocker: cap === '0' ? 'W3_SHIPPING_CAP_EXCEEDED' : 'FINANCE_LEDGER_SOURCE_REQUIRED' } },
    });
    await expect(
      service.actual(
        randomUUID(),
        {
          commandId: randomUUID(),
          expectedVersion: 3,
          quoteVersion: 1,
          evidenceId: randomUUID(),
          totalShippingFee: 1,
        },
        actor,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { details: { blocker: 'FINANCE_LEDGER_SOURCE_REQUIRED' } },
    });
    expect(f.rows('DeliveryShippingProposal')).toHaveLength(0);
    expect(f.movements).toHaveLength(0);
  });
  it('allows explicit zero spending alongside an unknown sibling without reporting a verified order budget', async () => {
    const f = fixture();
    f.rows('PartRequest').push({
      ...f.request,
      id: randomUUID(),
      shippingFee: null,
    });
    const result = await f.propose();
    expect(result.quote?.laborBudget).toBe('UNVERIFIED');
    expect(result.financialExecution).toBe('BLOCKED');
    expect(result.quote).not.toHaveProperty('netLaborAfterShipping');
  });
  it('fails closed when the independent approved fee is missing rather than treating it as zero', async () => {
    const f = fixture();
    f.cost.shippingFee = null;
    await expect(f.propose()).rejects.toMatchObject({ status: 409 });
    expect(f.rows('DeliveryConsentSession')).toHaveLength(0);
  });
  it('executes the whole zero-fee delivery with separate receipts and stock issue once', async () => {
    const f = fixture();
    await f.ready();
    const body = { commandId: randomUUID(), expectedVersion: 0 };
    const reserved = await f.service.physical(
      f.request.id,
      'RESERVE',
      body,
      f.actor(f.tech),
    );
    expect(reserved.state.status).toBe('RESERVED');
    expect(f.stocks.map((s) => s.reserved)).toEqual([2, 2]);
    expect(
      (await f.service.physical(f.request.id, 'RESERVE', body, f.actor(f.tech)))
        .replayed,
    ).toBe(true);
    for (const [i, kind] of [
      'ISSUE_TO_COURIER',
      'COURIER_DISPATCH',
      'TECHNICIAN_RECEIPT',
    ].entries()) {
      const u = i === 2 ? f.tech : f.sm;
      const e = await f.upload(kind, u);
      await f.service.physical(
        f.request.id,
        kind as any,
        {
          commandId: randomUUID(),
          expectedVersion: i + 1,
          evidenceId: e.evidenceId,
        },
        f.actor(u),
      );
    }
    const read = await f.service.read(f.request.id, f.actor(f.customer));
    expect(read.physical?.status).toBe('TECHNICIAN_RECEIVED');
    expect(read.physical?.evidence).toHaveLength(3);
    expect(read.financialExecution).toBe('BLOCKED');
    expect(f.stocks.map((s) => [s.onHand, s.reserved])).toEqual([
      [1, 0],
      [1, 0],
    ]);
    expect(f.rows('Invoice')).toHaveLength(0);
    expect(f.rows('PartCustody')).toHaveLength(0);
    expect(f.rows('PartRequest')[0].receivedAt).toBeUndefined();
  });
  it('does not reserve with one consent or replace consent with fee=0', async () => {
    const f = fixture();
    await f.sign(await f.propose(), f.customer);
    await expect(
      f.service.physical(
        f.request.id,
        'RESERVE',
        { commandId: randomUUID(), expectedVersion: 0 },
        f.actor(f.tech),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.movements).toHaveLength(0);
  });
  it('releases reservations before issue and never reverses physically issued stock', async () => {
    const f = fixture();
    await f.ready();
    await f.service.physical(
      f.request.id,
      'RESERVE',
      { commandId: randomUUID(), expectedVersion: 0 },
      f.actor(f.tech),
    );
    await f.service.physical(
      f.request.id,
      'RELEASE',
      { commandId: randomUUID(), expectedVersion: 1 },
      f.actor(f.sm),
    );
    expect(f.stocks.map((s) => [s.onHand, s.reserved])).toEqual([
      [3, 0],
      [3, 0],
    ]);
  });
  it('lets the current warehouse manager release stale reservations without relying on the old consent or manager', async () => {
    const f = fixture();
    await f.ready();
    await f.service.physical(
      f.request.id,
      'RESERVE',
      { commandId: randomUUID(), expectedVersion: 0 },
      f.actor(f.tech),
    );
    const replacement = {
      id: randomUUID(),
      role: Role.SERVICE_MANAGER,
      isActive: true,
      status: 'active',
    };
    f.rows('User').push(replacement);
    f.rows('User').find((u) => u.id === f.sm.id).isActive = false;
    f.warehouse.responsibleUserId = replacement.id;
    f.rows('DeliveryConsentSession')[0].invalidatedAt = new Date();
    await f.service.physical(
      f.request.id,
      'RELEASE',
      { commandId: randomUUID(), expectedVersion: 1 },
      f.actor(replacement),
    );
    expect(f.stocks.every((s) => s.onHand === 3 && s.reserved === 0)).toBe(
      true,
    );
  });
  it('keeps cancelled proposal history but marks both consents invalid in the read model', async () => {
    const f = fixture();
    await f.ready();
    f.rows('PartRequest')[0].status = 'cancelled';
    const r = await f.service.read(f.request.id, f.actor(f.customer));
    expect(r.invalidated).toBe(true);
    expect(r.customerConsented).toBe(false);
    expect(r.technicianConsented).toBe(false);
    expect(f.rows('DeliveryConsentCommandRecord')).toHaveLength(4);
  });
  it('invalidates consents when quantity/source or warehouse authority changes', async () => {
    const f = fixture();
    await f.ready();
    f.rows('PartRequestItem')[0].quantity = 1;
    expect(
      (await f.service.read(f.request.id, f.actor(f.customer))).invalidated,
    ).toBe(true);
    await expect(
      f.service.physical(
        f.request.id,
        'RESERVE',
        { commandId: randomUUID(), expectedVersion: 0 },
        f.actor(f.tech),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('keeps positive shipping blocked, even when a zero actual is requested', async () => {
    const f = fixture();
    f.cost.shippingFee = 20000;
    await expect(f.propose()).rejects.toMatchObject({
      status: 409,
      response: { details: { blocker: 'FINANCE_LEDGER_SOURCE_REQUIRED' } },
    });
    expect(f.rows('DeliveryConsentSession')).toHaveLength(0);
  });
  it('returns pending assistance without retaining any partial SKU when the final SKU is short', async () => {
    const f = fixture();
    await f.ready();
    f.stocks[1].onHand = 1;
    const r = await f.service.physical(
      f.request.id,
      'RESERVE',
      { commandId: randomUUID(), expectedVersion: 0 },
      f.actor(f.tech),
    );
    expect(r.state.status).toBe('PENDING_ASSISTANCE');
    expect(f.movements).toHaveLength(0);
    expect(f.stocks.every((s) => s.reserved === 0)).toBe(true);
  });
  it('rolls back event and every movement if transactional audit fails', async () => {
    const f = fixture();
    await f.ready();
    const insert = f.manager.insert.getMockImplementation()!;
    f.manager.insert.mockImplementation(async (type: any, row: any) => {
      if (type.name === 'AuditLog' && row.action === 'DELIVERY_RESERVE')
        throw new Error('audit unavailable');
      return insert(type, row);
    });
    await expect(
      f.service.physical(
        f.request.id,
        'RESERVE',
        { commandId: randomUUID(), expectedVersion: 0 },
        f.actor(f.tech),
      ),
    ).rejects.toThrow('audit unavailable');
    expect(f.rows('WarehouseDeliveryEvent')).toHaveLength(0);
    expect(f.movements).toHaveLength(0);
    expect(f.stocks.every((s) => s.reserved === 0)).toBe(true);
  });
  it('keeps zero-fee dual consent explicit and rejects stale CAS and a duplicate actor consent', async () => {
    const f = fixture();
    const p = await f.propose();
    await f.sign(p, f.customer);
    await expect(f.sign(p, f.tech)).rejects.toMatchObject({ status: 409 });
    const current = await f.service.read(f.request.id, f.actor(f.customer));
    await expect(f.sign(current, f.customer)).rejects.toMatchObject({
      status: 409,
    });
    expect(f.rows('DeliveryConsentCommandRecord')).toHaveLength(2);
  });
  it('renewing a proposal invalidates both old consents and does not expose a made-up labor budget', async () => {
    const f = fixture();
    await f.ready();
    const r = await f.propose(4);
    expect(r.quote?.quoteVersion).toBe(2);
    expect(r.quote).not.toHaveProperty('budget');
    expect(r.quote).not.toHaveProperty('netLaborAfterShipping');
    const read = await f.service.read(f.request.id, f.actor(f.customer));
    expect(read.customerConsented).toBe(false);
    expect(read.technicianConsented).toBe(false);
    expect(read.quote?.laborBudget).toBe('UNVERIFIED');
  });
  it('rejects foreign actor and evidence from another warehouse, purpose or quote version', async () => {
    const f = fixture();
    await f.ready();
    const e = await f.upload('ISSUE_TO_COURIER');
    f
      .rows('DeliveryOperationEvidence')
      .find((r) => r.id === e.evidenceId).warehouseId = randomUUID();
    await f.service.physical(
      f.request.id,
      'RESERVE',
      { commandId: randomUUID(), expectedVersion: 0 },
      f.actor(f.tech),
    );
    await expect(
      f.service.physical(
        f.request.id,
        'ISSUE_TO_COURIER',
        {
          commandId: randomUUID(),
          expectedVersion: 1,
          evidenceId: e.evidenceId,
        },
        f.actor(f.sm),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.service.read(f.request.id, { id: randomUUID(), role: Role.CUSTOMER }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('rejects a second stage with the same bytes under a fresh upload ID', async () => {
    const f = fixture();
    await f.ready();
    await f.service.physical(
      f.request.id,
      'RESERVE',
      { commandId: randomUUID(), expectedVersion: 0 },
      f.actor(f.tech),
    );
    const issue = await f.upload('ISSUE_TO_COURIER', f.sm, 1, 'same bytes');
    await f.service.physical(
      f.request.id,
      'ISSUE_TO_COURIER',
      {
        commandId: randomUUID(),
        expectedVersion: 1,
        evidenceId: issue.evidenceId,
      },
      f.actor(f.sm),
    );
    const dispatch = await f.upload('COURIER_DISPATCH', f.sm, 1, 'same bytes');
    await expect(
      f.service.physical(
        f.request.id,
        'COURIER_DISPATCH',
        {
          commandId: randomUUID(),
          expectedVersion: 2,
          evidenceId: dispatch.evidenceId,
        },
        f.actor(f.sm),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.service.physical(
        f.request.id,
        'RELEASE',
        { commandId: randomUUID(), expectedVersion: 2 },
        f.actor(f.sm),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.stocks.every((s) => s.onHand === 1)).toBe(true);
  });
  it('rejects a foreign principal before evidence upload or mutation', async () => {
    const manager: any = {
      queryRunner: { isTransactionActive: true },
      findOne: vi.fn(async () => null),
    };
    const storage: any = { upload: vi.fn() };
    const service = new DeliveryOperationsService(
      { transaction: (fn: any) => fn(manager) } as any,
      storage,
    );
    await expect(
      service.read(randomUUID(), { id: randomUUID(), role: Role.CUSTOMER }),
    ).rejects.toMatchObject({ status: 404 });
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it('rejects client money, actor and verdict fields instead of granting authority', async () => {
    const db: any = { transaction: vi.fn() };
    const service = new DeliveryOperationsService(db, {} as any);
    await expect(
      service.propose(
        randomUUID(),
        {
          commandId: randomUUID(),
          expectedVersion: 0,
          warehouseId: randomUUID(),
          evidenceId: randomUUID(),
          courierReference: 'manual-quote',
          totalShippingFee: 0,
          actorId: randomUUID(),
          shippingApproved: true,
        } as any,
        { id: randomUUID(), role: Role.SERVICE_MANAGER },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('never substitutes a fee ceiling or zero default for an explicit proposal amount', async () => {
    const service = new DeliveryOperationsService(
      { transaction: vi.fn() } as any,
      {} as any,
    );
    await expect(
      service.propose(
        randomUUID(),
        {
          commandId: randomUUID(),
          expectedVersion: 0,
          warehouseId: randomUUID(),
          evidenceId: randomUUID(),
          courierReference: 'manual-quote',
        } as any,
        { id: randomUUID(), role: Role.SERVICE_MANAGER },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
