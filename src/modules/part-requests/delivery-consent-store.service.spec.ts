import { describe, expect, it, vi } from 'vitest';
import type { EntityManager, QueryRunner } from 'typeorm';
import { DeliveryConsentState1793466000005 } from '../../database/migrations/1793466000005-DeliveryConsentState';
import { Role } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { PartRequest } from './entities/part-request.entity';
import { WarehouseAllocation } from './entities/warehouse-allocation.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { DeliveryConsentSession } from './entities/delivery-consent-session.entity';
import { DeliveryConsentCommandRecord } from './entities/delivery-consent-command.entity';
import { DeliveryEvidenceRecord } from './entities/delivery-evidence-record.entity';
import { DeliveryConsentStoreService } from './delivery-consent-store.service';
import { createDeliveryProposal } from './delivery-consent.policy';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Persistence double: proves service behavior, NOT PostgreSQL constraints/rollback/concurrency. */
function fixture() {
  const tables = new Map<any, any[]>();
  const rows = (entity: any) => {
    if (!tables.has(entity)) tables.set(entity, []);
    return tables.get(entity)!;
  };
  const seed = (entity: any, value: any) => {
    rows(entity).push(value);
    return value;
  };
  const customer = seed(User, {
    id: id(1),
    role: Role.CUSTOMER,
    isActive: true,
    status: 'active',
  });
  const technician = seed(User, {
    id: id(2),
    role: Role.TECHNICIAN,
    isActive: true,
    status: 'active',
  });
  const sm = seed(User, {
    id: id(3),
    role: Role.SERVICE_MANAGER,
    isActive: true,
    status: 'active',
  });
  const booking = seed(Booking, { id: id(4), customerId: customer.id });
  const order = seed(ServiceOrder, {
    id: id(5),
    bookingId: booking.id,
    status: 'under_repair',
    completionRequestedAt: null,
  });
  const assignment = seed(TechnicianAssignment, {
    id: id(6),
    serviceOrderId: order.id,
    technicianId: technician.id,
    isActive: true,
  });
  const cost = seed(AdditionalCostRequest, {
    id: id(7),
    serviceOrderId: order.id,
    technicianId: technician.id,
    status: 'approved',
    decidedByCustomerId: customer.id,
    decidedAt: new Date('2026-11-04T00:00:00Z'),
    shippingFee: 20_000,
    totalLaborDelta: 0,
    totalPartsDelta: 0,
    fulfillmentMethod: 'delivery',
  });
  const request = seed(PartRequest, {
    id: id(8),
    serviceOrderId: order.id,
    technicianId: technician.id,
    requestType: 'additional',
    status: 'requested',
    fulfillmentMethod: 'delivery',
    additionalCostId: cost.id,
    quotationId: null,
  });
  const matches = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([key, value]: [string, any]) =>
      value?._type === 'isNull'
        ? row[key] == null
        : value?._type === 'in'
          ? value._value.includes(row[key])
          : row[key] === value,
    );
  const double = {
    queryRunner: { isTransactionActive: true },
    findOne: vi.fn(async (entity, options) =>
      structuredClone(
        rows(entity).find((row) => matches(row, options?.where)) ?? null,
      ),
    ),
    find: vi.fn(async (entity, options?: any) =>
      structuredClone(
        rows(entity).filter((row) => matches(row, options?.where)),
      ),
    ),
    insert: vi.fn(async (entity, value) => {
      rows(entity).push(structuredClone(value));
      return { identifiers: [] };
    }),
    update: vi.fn(async (entity, where, value) => {
      const row = rows(entity).find((row) => matches(row, where));
      if (!row) return { affected: 0 };
      Object.assign(row, structuredClone(value));
      return { affected: 1 };
    }),
  };
  const manager = double as typeof double & EntityManager;
  // Database orderBy for the journal; do not sort by insertion order accidentally.
  manager.find.mockImplementation(async (entity, options?: any) => {
    const found = structuredClone(
      rows(entity).filter((row) => matches(row, options?.where)),
    );
    return options?.order?.resultVersion
      ? found.sort((a, b) => a.resultVersion - b.resultVersion)
      : found;
  });
  const store = new DeliveryConsentStoreService();
  const actor = (user: any) => ({ id: user.id, role: user.role });
  const metadata = (
    purpose: 'QUOTE' | 'ACTUAL' = 'QUOTE',
    quoteVersion = 1,
    n = 20,
  ) => ({
    id: id(n),
    purpose,
    quoteVersion,
    privateObjectRef: `cloudinary://evidence/fixhome/evidence/${order.id}/${sm.id}/${id(n)}`,
    contentDigest: 'a'.repeat(64),
    mimeType: 'image/jpeg',
    fileSize: 1024,
    retainUntil: null,
  });
  const proposal = (overrides = {}) => ({
    kind: 'PROPOSE' as const,
    commandId: id(30),
    expectedVersion: 0,
    totalShippingFee: 20_000,
    budget: {
      laborTotal: 100_000,
      commissionAmount: 10_000,
      knownApprovedDeductions: 0,
    },
    approvedCostRef: `additional-cost:${cost.id}`,
    evidenceRef: `delivery-evidence:${id(20)}`,
    ...overrides,
  });
  const start = async () => {
    await store.appendEvidence(manager, request.id, metadata(), actor(sm));
    return store.execute(manager, request.id, proposal(), actor(sm));
  };
  const sign = (state: any, user: any, n = 31) => ({
    kind: 'CONSENT' as const,
    commandId: id(n),
    expectedVersion: state.version,
    quoteVersion: state.quote.quoteVersion,
    quoteFingerprint: state.quote.fingerprint,
    totalShippingFee: state.quote.totalShippingFee,
    shippingShare:
      user.role === Role.CUSTOMER
        ? state.quote.customerShippingShare
        : state.quote.technicianShippingShare,
    accepted: true as const,
    evidenceRef: `delivery-consent:${request.id}:${id(n)}`,
  });
  return {
    store,
    manager,
    rows,
    seed,
    customer,
    technician,
    sm,
    booking,
    order,
    assignment,
    request,
    cost,
    actor,
    metadata,
    proposal,
    start,
    sign,
  };
}

describe('B1 inert delivery consent store', () => {
  it.each([
    'manual_assistance',
    'reserved',
    'ready',
    'handed_over',
    'received',
    'released',
  ])(
    'never reads or binds W2 allocation authority, including status %s',
    async (status) => {
      const f = fixture();
      const warehouse = f.seed(Warehouse, {
        id: id(60),
        responsibleUserId: f.sm.id,
        status: 'active',
      });
      const allocation = f.seed(WarehouseAllocation, {
        partRequestId: f.request.id,
        warehouseId: warehouse.id,
        responsibleUserId: f.sm.id,
        technicianId: f.technician.id,
        status,
        handedOverAt: new Date('2026-11-04T00:00:00Z'),
        handedOverBy: f.sm.id,
      });
      const result = await f.start();
      expect(f.rows(DeliveryConsentSession)[0].warehouseId).toBeNull();
      expect(result.state.scope.responsibleServiceManagerId).toBe(f.sm.id);
      // Changes to the historical PICKUP allocation cannot become B1 authority or invalidate B1.
      allocation.status = 'released';
      allocation.warehouseId = id(61);
      warehouse.responsibleUserId = id(62);
      expect(
        (
          await f.store.execute(
            f.manager,
            f.request.id,
            f.proposal(),
            f.actor(f.sm),
          )
        ).replayed,
      ).toBe(true);
      expect(
        f.manager.findOne.mock.calls.some(
          ([entity]) => entity === WarehouseAllocation || entity === Warehouse,
        ),
      ).toBe(false);
    },
  );
  it('emits a B1 NULL-only warehouse CHECK and no W2 allocation dependency (static SQL contract, not PG execution)', async () => {
    const runner = { query: vi.fn(async (_sql: string) => []) };
    await new DeliveryConsentState1793466000005().up(
      runner as unknown as QueryRunner,
    );
    const sql = runner.query.mock.calls.map(([query]) => query).join('\n');
    expect(sql).toMatch(
      /CONSTRAINT ck_delivery_b1_no_warehouse CHECK\s*\(warehouse_id IS NULL\)/,
    );
    expect(sql).not.toContain('part_request_warehouse_allocations');
    const scope = sql.slice(
      sql.indexOf('CREATE FUNCTION delivery_consent_scope_matches'),
      sql.indexOf('CREATE FUNCTION delivery_consent_session_guard'),
    );
    expect(scope).toContain('AND (s).warehouse_id IS NULL');
    expect(scope).not.toContain('JOIN warehouses');
    // Review fix must preserve the existing cross-identity guards.
    for (const clause of [
      'p.service_order_id=(s).service_order_id',
      'p.technician_id=(s).technician_user_id',
      'b.customer_id=(s).customer_user_id',
      'a.id=(s).active_assignment_id',
      'a.technician_id=(s).technician_user_id AND a.is_active',
      "m.role::text='service_manager'",
      'ac.decided_by_customer_id=b.customer_id',
    ])
      expect(scope).toContain(clause);
  });
  it('requires the caller transaction before any database read/write', async () => {
    const f = fixture();
    f.manager.queryRunner.isTransactionActive = false;
    await expect(
      f.store.execute(f.manager, f.request.id, f.proposal(), f.actor(f.sm)),
    ).rejects.toThrow('TRANSACTION_REQUIRED');
    expect(f.manager.findOne).not.toHaveBeenCalled();
    expect(f.manager.insert).not.toHaveBeenCalled();
  });
  it('derives coherent server identity and persists projection + command + audit without requiring a warehouse', async () => {
    const f = fixture();
    const result = await f.start();
    const expected = createDeliveryProposal(
      {
        partRequestId: f.request.id,
        serviceOrderId: f.order.id,
        customerId: f.customer.id,
        technicianId: f.technician.id,
        responsibleServiceManagerId: f.sm.id,
      },
      f.proposal(),
      f.actor(f.sm),
    );
    expect(result.state).toEqual(expected);
    expect(result.replayed).toBe(false);
    expect(f.rows(DeliveryConsentSession)[0]).toMatchObject({
      assignmentId: f.assignment.id,
      warehouseId: null,
      version: 1,
    });
    expect(f.rows(DeliveryConsentCommandRecord)).toHaveLength(1);
    expect(f.rows(AuditLog)).toHaveLength(1);
    expect(f.rows(DeliveryConsentSession)[0].projection).not.toHaveProperty(
      'receipts',
    );
  });
  it('roundtrips JSONB snapshots and exact idempotent replay with no new writes', async () => {
    const f = fixture();
    await f.start();
    const first = await f.store.read(f.manager, f.request.id);
    f.manager.insert.mockClear();
    f.manager.update.mockClear();
    const replay = await f.store.execute(
      f.manager,
      f.request.id,
      f.proposal(),
      f.actor(f.sm),
    );
    expect(replay.state).toEqual(first);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.resultVersion).toBe(1);
    expect(f.manager.insert).not.toHaveBeenCalled();
    expect(f.manager.update).not.toHaveBeenCalled();
  });
  it('rejects key reuse with changed payload rather than replacing a receipt', async () => {
    const f = fixture();
    await f.start();
    await expect(
      f.store.execute(
        f.manager,
        f.request.id,
        f.proposal({ totalShippingFee: 21_000 }),
        f.actor(f.sm),
      ),
    ).rejects.toThrow('COMMAND_CONFLICT');
    expect(f.rows(DeliveryConsentCommandRecord)).toHaveLength(1);
  });
  it('persists both distinct consents and frozen lower actual, leaving financial activation closed', async () => {
    const f = fixture();
    let r = await f.start();
    r = await f.store.execute(
      f.manager,
      f.request.id,
      f.sign(r.state, f.customer),
      f.actor(f.customer),
    );
    r = await f.store.execute(
      f.manager,
      f.request.id,
      f.sign(r.state, f.technician, 32),
      f.actor(f.technician),
    );
    await f.store.appendEvidence(
      f.manager,
      f.request.id,
      f.metadata('ACTUAL', 1, 21),
      f.actor(f.sm),
    );
    r = await f.store.execute(
      f.manager,
      f.request.id,
      {
        kind: 'RECORD_ACTUAL',
        commandId: id(33),
        expectedVersion: 3,
        quoteVersion: 1,
        totalShippingFee: 15_000,
        evidenceRef: `delivery-evidence:${id(21)}`,
      },
      f.actor(f.sm),
    );
    expect(r.state).toMatchObject({
      version: 4,
      status: 'ACTUAL_RECORDED',
      payoutBlockReason: 'FINANCIAL_CUTOVER_CLOSED',
      actual: { totalShippingFee: 15_000, customerShippingShare: 10_500 },
    });
    expect(await f.store.read(f.manager, f.request.id)).toEqual(r.state);
  });
  it('uses CAS and refuses a new receipt when the root update lost its revision', async () => {
    const f = fixture();
    const r = await f.start();
    f.manager.update.mockResolvedValueOnce({ affected: 0 });
    f.manager.insert.mockClear();
    await expect(
      f.store.execute(
        f.manager,
        f.request.id,
        f.sign(r.state, f.customer),
        f.actor(f.customer),
      ),
    ).rejects.toThrow('CAS_CONFLICT');
    expect(f.manager.insert).not.toHaveBeenCalled();
  });
  it('rejects stale versions before writing', async () => {
    const f = fixture();
    const r = await f.start();
    await f.store.execute(
      f.manager,
      f.request.id,
      f.sign(r.state, f.customer),
      f.actor(f.customer),
    );
    await expect(
      f.store.execute(
        f.manager,
        f.request.id,
        f.sign(r.state, f.technician, 32),
        f.actor(f.technician),
      ),
    ).rejects.toThrow('STALE_VERSION');
    expect(f.rows(DeliveryConsentCommandRecord)).toHaveLength(2);
  });
  it.each([
    'request_order',
    'request_technician',
    'booking_customer',
    'assignment',
    'actor_role',
    'actor_disabled',
    'source',
    'pickup',
    'warranty',
  ])('fails closed on changed/mismatched scope: %s', async (issue) => {
    const f = fixture();
    const r = await f.start();
    if (issue === 'request_order') f.request.serviceOrderId = id(90);
    if (issue === 'request_technician') f.request.technicianId = id(90);
    if (issue === 'booking_customer') f.booking.customerId = id(90);
    if (issue === 'assignment') f.assignment.isActive = false;
    if (issue === 'actor_role') f.customer.role = Role.ADMIN;
    if (issue === 'actor_disabled') f.customer.isActive = false;
    if (issue === 'source') f.cost.serviceOrderId = id(90);
    if (issue === 'pickup') f.request.fulfillmentMethod = 'pickup';
    if (issue === 'warranty') f.request.requestType = 'warranty';
    f.manager.insert.mockClear();
    f.manager.update.mockClear();
    await expect(
      f.store.execute(f.manager, f.request.id, f.sign(r.state, f.customer), {
        id: f.customer.id,
        role: Role.CUSTOMER,
      }),
    ).rejects.toThrow();
    expect(f.manager.insert).not.toHaveBeenCalled();
    expect(f.manager.update).not.toHaveBeenCalled();
  });
  it('does not accept caller-provided arbitrary approval or evidence references', async () => {
    const f = fixture();
    await f.store.appendEvidence(
      f.manager,
      f.request.id,
      f.metadata(),
      f.actor(f.sm),
    );
    for (const value of [
      { approvedCostRef: 'client-approved' },
      { evidenceRef: 'https://example.test/image' },
      { evidenceRef: `delivery-evidence:${id(99)}` },
    ]) {
      await expect(
        f.store.execute(
          f.manager,
          f.request.id,
          f.proposal(value),
          f.actor(f.sm),
        ),
      ).rejects.toThrow();
    }
    expect(f.rows(DeliveryConsentSession)).toHaveLength(0);
  });
  it('rejects cross-request evidence and consent evidence not bound to this command', async () => {
    const f = fixture();
    const r = await f.start();
    await expect(
      f.store.execute(
        f.manager,
        f.request.id,
        { ...f.sign(r.state, f.customer), evidenceRef: 'client-said-yes' },
        f.actor(f.customer),
      ),
    ).rejects.toThrow('EVIDENCE');
    f.rows(DeliveryEvidenceRecord)[0].partRequestId = id(99);
    await expect(
      f.store.execute(
        f.manager,
        f.request.id,
        f.proposal({ commandId: id(40) }),
        f.actor(f.sm),
      ),
    ).rejects.toThrow();
  });
  it('does not infer shipping approval or compute a finance budget from source approval totals', async () => {
    const f = fixture();
    const r = await f.start();
    expect(f.cost.totalLaborDelta).toBe(0);
    expect(r.state.quote.budget.laborTotal).toBe(100_000); // Trusted adapter input, not an invented B1 financial verdict.
    expect(r.state.payoutBlockReason).toBe('FINANCIAL_CUTOVER_CLOSED');
  });
  it('propagates audit failure for caller rollback, without a private commit', async () => {
    const f = fixture();
    const original = f.manager.insert.getMockImplementation()!;
    f.manager.insert.mockImplementation(async (entity, value) => {
      if (entity === AuditLog) throw new Error('audit unavailable');
      return original(entity, value);
    });
    await expect(f.start()).rejects.toThrow('audit unavailable'); // A PG test, not this double, proves rollback.
  });
  it('rejects tampered projections/journal rather than trusting cached state', async () => {
    const f = fixture();
    await f.start();
    f.rows(DeliveryConsentSession)[0].projection.quote.customerShippingShare =
      1;
    await expect(f.store.read(f.manager, f.request.id)).rejects.toThrow();
  });
  it('keeps reassignment legal, explicitly invalidates only stale scope and preserves the complete history', async () => {
    const f = fixture();
    await f.start();
    expect(
      await f.store.invalidateIfScopeChanged(f.manager, f.request.id),
    ).toBe(false);
    f.assignment.isActive = false;
    expect(
      await f.store.invalidateIfScopeChanged(f.manager, f.request.id),
    ).toBe(true);
    expect(f.rows(DeliveryConsentSession)[0]).toMatchObject({
      version: 1,
      invalidationReason: 'SCOPE_CHANGED',
    });
    expect((await f.store.read(f.manager, f.request.id)).version).toBe(1);
    expect(f.rows(DeliveryConsentCommandRecord)).toHaveLength(1);
    await expect(
      f.store.execute(f.manager, f.request.id, f.proposal(), f.actor(f.sm)),
    ).rejects.toThrow();
  });
  it('rejects public URLs, malformed digests, invalid purposes and cross-owner private objects in evidence metadata', async () => {
    const f = fixture();
    for (const overrides of [
      { privateObjectRef: 'https://example.test/image.jpg' },
      { contentDigest: 'not-a-digest' },
      { purpose: 'CONSENT' },
      { createdAt: new Date('2020-01-01T00:00:00Z') },
      {
        privateObjectRef: `cloudinary://evidence/fixhome/evidence/${id(99)}/${f.sm.id}/${id(20)}`,
      },
    ]) {
      await expect(
        f.store.appendEvidence(
          f.manager,
          f.request.id,
          { ...f.metadata(), ...overrides } as any,
          f.actor(f.sm),
        ),
      ).rejects.toThrow();
    }
    expect(f.rows(DeliveryEvidenceRecord)).toHaveLength(0);
  });
  it('roundtrips a revised quote and replays an old receipt without restoring old consent', async () => {
    const f = fixture();
    let result = await f.start();
    const consent = f.sign(result.state, f.customer);
    result = await f.store.execute(
      f.manager,
      f.request.id,
      consent,
      f.actor(f.customer),
    );
    await f.store.appendEvidence(
      f.manager,
      f.request.id,
      f.metadata('QUOTE', 2, 22),
      f.actor(f.sm),
    );
    result = await f.store.execute(
      f.manager,
      f.request.id,
      f.proposal({
        kind: 'REVISE',
        commandId: id(40),
        expectedVersion: 2,
        totalShippingFee: 25_000,
        evidenceRef: `delivery-evidence:${id(22)}`,
      }),
      f.actor(f.sm),
    );
    const replay = await f.store.execute(
      f.manager,
      f.request.id,
      consent,
      f.actor(f.customer),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.resultVersion).toBe(2);
    expect(replay.state).toEqual(result.state);
    expect(replay.state.customerConsent).toBeNull();
    expect(
      (await f.store.read(f.manager, f.request.id)).quote.quoteVersion,
    ).toBe(2);
  });
  it('pins the approved source content for new consent commands', async () => {
    const f = fixture();
    const result = await f.start();
    f.cost.shippingFee = 21_000;
    await expect(
      f.store.execute(
        f.manager,
        f.request.id,
        f.sign(result.state, f.customer),
        f.actor(f.customer),
      ),
    ).rejects.toThrow('SOURCE_CHANGED');
    expect(f.rows(DeliveryConsentCommandRecord)).toHaveLength(1);
  });
  it('binds the actual approved Quotation ID/version without inventing shipping approval', async () => {
    const f = fixture();
    f.request.requestType = 'quotation';
    f.request.additionalCostId = null;
    f.request.quotationId = id(9);
    const quote = f.seed(Quotation, {
      id: id(9),
      serviceOrderId: f.order.id,
      technicianId: f.technician.id,
      status: 'approved',
      decidedAt: new Date('2026-11-04T00:00:00Z'),
      version: 2,
      laborTotal: 100_000,
      partsTotal: 0,
    });
    await f.store.appendEvidence(
      f.manager,
      f.request.id,
      f.metadata(),
      f.actor(f.sm),
    );
    const result = await f.store.execute(
      f.manager,
      f.request.id,
      f.proposal({ approvedCostRef: `quotation:${id(9)}:2` }),
      f.actor(f.sm),
    );
    expect(f.rows(DeliveryConsentSession)[0]).toMatchObject({
      sourceQuotationId: id(9),
      sourceAdditionalCostId: null,
    });
    expect(f.rows(DeliveryConsentCommandRecord)[0].sourceVersion).toBe(2);
    expect(result.state.payoutBlockReason).toBe('FINANCIAL_CUTOVER_CLOSED');
    quote.version = 3;
    await expect(
      f.store.execute(
        f.manager,
        f.request.id,
        f.sign(result.state, f.customer),
        f.actor(f.customer),
      ),
    ).rejects.toThrow('SOURCE_CHANGED');
  });
  it('reauthorizes the active customer on an exact replay and rejects revoked source approval', async () => {
    const f = fixture();
    const result = await f.start();
    const consent = f.sign(result.state, f.customer);
    await f.store.execute(
      f.manager,
      f.request.id,
      consent,
      f.actor(f.customer),
    );
    f.customer.isActive = false;
    await expect(
      f.store.execute(f.manager, f.request.id, consent, f.actor(f.customer)),
    ).rejects.toThrow('ACTOR_DENIED');
    f.customer.isActive = true;
    f.cost.status = 'rejected';
    await expect(
      f.store.execute(f.manager, f.request.id, consent, f.actor(f.customer)),
    ).rejects.toThrow('SOURCE_MISMATCH');
  });
  it('preserves a known-deductions blocker as data and never invents a destination ledger', async () => {
    const f = fixture();
    await f.store.appendEvidence(
      f.manager,
      f.request.id,
      f.metadata(),
      f.actor(f.sm),
    );
    const result = await f.store.execute(
      f.manager,
      f.request.id,
      f.proposal({
        budget: {
          laborTotal: 100_000,
          commissionAmount: 10_000,
          knownApprovedDeductions: 1_000,
        },
      }),
      f.actor(f.sm),
    );
    expect(result.state.payoutBlockReason).toBe(
      'KNOWN_DEDUCTIONS_LEDGER_REQUIRED',
    );
    expect(result.state.quote.netLaborAfterShipping).toBe(83_000);
    expect([...f.rows(DeliveryConsentCommandRecord)]).toHaveLength(1);
  });
  it('blocks new consents once an invoice exists, while preserving an authorized committed replay', async () => {
    const f = fixture();
    const result = await f.start();
    const { Invoice } =
      await import('../service-orders/entities/invoice.entity');
    f.seed(Invoice, { serviceOrderId: f.order.id });
    await expect(
      f.store.execute(
        f.manager,
        f.request.id,
        f.sign(result.state, f.customer),
        f.actor(f.customer),
      ),
    ).rejects.toThrow('ORDER_FROZEN');
    expect(
      (
        await f.store.execute(
          f.manager,
          f.request.id,
          f.proposal(),
          f.actor(f.sm),
        )
      ).replayed,
    ).toBe(true);
  });
});
