import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSource, FindOperator } from 'typeorm';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PartCustodyService } from './part-custody.service';
import { PartReturnsController } from './part-returns.controller';
import { PartRequestsService } from './part-requests.service';
import { createPartCustodySnapshot } from './part-custody.rules';
import { releaseOutgoingTechnicianPartRequests } from './part-request-lifecycle';
import { ServiceOrdersService } from '../service-orders/service-orders.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import {
  AccountStatus,
  BookingStatus,
  PartRequestStatus,
  PartRequestType,
  PartSource,
  PartUsageStatus,
  Role,
  ServiceOrderStatus,
  ServicePricingMode,
} from '../../shared/enums';

const tech = { id: 'original-tech', role: Role.TECHNICIAN };
const sm = { id: 'manager', role: Role.SERVICE_MANAGER };
const otherTech = { id: 'replacement-tech', role: Role.TECHNICIAN };
const command = (
  quantity: number,
  expectedVersion: number,
  idempotencyKey: string,
) => ({ quantity, expectedVersion, idempotencyKey });

// Only storage is doubled. Authorization, failure transition, custody rules,
// controller roles and part-request lifecycle execute their production code.
// Serialization here is NOT evidence of PostgreSQL locks/unique indexes/RLS.
function fixture() {
  vi.stubEnv('PART_RETURNS_TRACKING_ENABLED', 'true');
  vi.stubEnv('P1_CUSTODY_ENABLED', 'false');
  const rows: Record<string, any[]> = {
    Booking: [
      {
        id: 'booking',
        customerId: 'customer',
        status: BookingStatus.MATCHED,
        pricingModeSnapshot: ServicePricingMode.FIXED_PRICE,
      },
    ],
    ServiceOrder: [
      {
        id: 'order',
        bookingId: 'booking',
        code: 'FH-T3-TEST',
        status: ServiceOrderStatus.UNDER_REPAIR,
        laborTotal: 100000,
        partsTotal: 20000,
        grandTotal: 120000,
      },
    ],
    TechnicianAssignment: [
      {
        id: 'assignment',
        serviceOrderId: 'order',
        technicianId: tech.id,
        isActive: true,
      },
    ],
    PartRequest: [
      {
        id: 'request',
        serviceOrderId: 'order',
        technicianId: tech.id,
        requestType: PartRequestType.PRE_REPAIR,
        status: PartRequestStatus.RECEIVED,
        receivedAt: new Date('2026-10-20T01:00:00Z'),
        items: [
          {
            id: 'item',
            partRequestId: 'request',
            quantity: 3,
            partSource: PartSource.FIXHOME,
            partNameSnapshot: 'Synthetic part',
            usageStatus: PartUsageStatus.RETURNED,
          },
        ],
      },
    ],
    PartRequestItem: [
      {
        id: 'item',
        partRequestId: 'request',
        partCatalogId: 'catalog',
        partSource: PartSource.FIXHOME,
        partNameSnapshot: 'Synthetic part',
        quantity: 3,
        usageStatus: PartUsageStatus.RETURNED,
      },
    ],
    PartCustody: [
      {
        id: 'custody',
        serviceOrderId: 'order',
        partRequestId: 'request',
        partRequestItemId: 'item',
        technicianId: tech.id,
        partNameSnapshot: 'Synthetic part',
        trackingOnly: true,
        cohortActivatedAt: new Date('2026-10-19T01:00:00Z'),
        handedOverAt: new Date('2026-10-20T01:00:00Z'),
        state: createPartCustodySnapshot({
          serviceOrderId: 'order',
          partRequestId: 'request',
          partRequestItemId: 'item',
          requestType: PartRequestType.PRE_REPAIR,
          additionalCostId: null,
          partCatalogId: 'catalog',
          source: PartSource.FIXHOME,
          originalCustodianTechnicianId: tech.id,
          issuedQty: 3,
          usedQty: 0,
          serviceOrderStatus: ServiceOrderStatus.UNDER_REPAIR,
          invoiceFrozen: false,
        }),
      },
    ],
    User: [
      { ...tech, isActive: true, status: AccountStatus.ACTIVE },
      { ...sm, isActive: true, status: AccountStatus.ACTIVE },
    ],
  };
  const table = (entity: { name: string }) => (rows[entity.name] ??= []);
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, value]) => {
      if (value instanceof FindOperator) {
        if (value.type !== 'in')
          throw new Error(`Unsupported fixture operator: ${value.type}`);
        return value.value.includes(row[key]);
      }
      return row[key] === value;
    });
  const manager: any = {
    find: async (entity, options) =>
      table(entity).filter((row) => matches(row, options?.where)),
    findOne: async (entity, options) =>
      table(entity).find((row) => matches(row, options?.where)) ?? null,
    findOneBy: async (entity, where) =>
      table(entity).find((row) => matches(row, where)) ?? null,
    findOneOrFail: async (entity, options) => {
      const row = table(entity).find((row) => matches(row, options?.where));
      if (!row) throw new Error('Fixture row not found');
      return row;
    },
    findOneByOrFail: async (entity, where) =>
      manager.findOneOrFail(entity, { where }),
    update: async (entity, where, patch) => {
      const selected = table(entity).filter((row) =>
        matches(row, typeof where === 'string' ? { id: where } : where),
      );
      selected.forEach((row) => Object.assign(row, patch));
      return { affected: selected.length };
    },
    create: (_entity, value) => value,
    save: async (entity, value) => {
      if (!table(entity).includes(value)) table(entity).push(value);
      value.id ??= `synthetic-${table(entity).length}`;
      return value;
    },
    insert: async (entity, value) => {
      table(entity).push(...(Array.isArray(value) ? value : [value]));
    },
    createQueryBuilder: (entity) => {
      if (entity?.name === 'PartRequestItem') {
        let antiCustody = false;
        let partSource: string | undefined;
        let requireReceived = false;
        let statuses: string[] | undefined;
        let offset = 0;
        let pageSize = 20;
        const matching = () => rows.PartRequestItem.filter((item) => {
          const request = rows.PartRequest.find((row) => row.id === item.partRequestId);
          if (!request) return false;
          if (partSource && item.partSource !== partSource) return false;
          if (requireReceived && !request.receivedAt) return false;
          if (statuses && !statuses.includes(request.status)) return false;
          if (antiCustody && rows.PartCustody.some((row) => row.partRequestItemId === item.id)) return false;
          return true;
        });
        const qb: any = {
          innerJoin: () => qb,
          select: () => qb,
          where: (sql: string) => {
            if (/NOT EXISTS/i.test(sql)) antiCustody = true;
            return qb;
          },
          andWhere: (sql: string, params?: any) => {
            if (/i\.part_source/.test(sql)) partSource = params.partSource;
            if (/r\.received_at IS NOT NULL/.test(sql)) requireReceived = true;
            if (/r\.status IN/.test(sql)) statuses = params.statuses;
            return qb;
          },
          orderBy: () => qb,
          addOrderBy: () => qb,
          offset: (value: number) => {
            offset = value;
            return qb;
          },
          limit: (value: number) => {
            pageSize = value;
            return qb;
          },
          getCount: async () => matching().length,
          getRawMany: async () => matching()
            .sort((left, right) => {
              const leftRequest = rows.PartRequest.find((row) => row.id === left.partRequestId)!;
              const rightRequest = rows.PartRequest.find((row) => row.id === right.partRequestId)!;
              const byReceivedAt = new Date(leftRequest.receivedAt).getTime() - new Date(rightRequest.receivedAt).getTime();
              return byReceivedAt !== 0 ? byReceivedAt : left.id.localeCompare(right.id);
            })
            .slice(offset, offset + pageSize)
            .map((item) => {
              const request = rows.PartRequest.find((row) => row.id === item.partRequestId)!;
              return {
                partRequestItemId: item.id,
                partRequestId: item.partRequestId,
                partCatalogId: item.partCatalogId ?? null,
                partNameSnapshot: item.partNameSnapshot,
                issuedQty: item.quantity,
                orderId: request.serviceOrderId,
                technicianId: request.technicianId,
                requestType: request.requestType,
                requestStatus: request.status,
                handedOverAt: request.receivedAt,
              };
            }),
        };
        return qb;
      }
      if (entity?.name !== 'PartCustody')
        throw new Error('Unexpected fixture query');
      let owner: string | undefined;
      let limit = 100;
      const qb = {
        where: () => qb,
        andWhere: (_sql, params) => {
          owner = params.technicianId;
          return qb;
        },
        orderBy: () => qb,
        addOrderBy: () => qb,
        take: (value) => {
          limit = value;
          return qb;
        },
        getMany: async () =>
          rows.PartCustody.filter(
            (row) =>
              row.state.outstandingQty > 0 &&
              (!owner || row.technicianId === owner),
          ).slice(0, limit),
      };
      return qb;
    },
  };
  let tail = Promise.resolve();
  const transaction = (callback: any) => {
    const result = tail.then(async () => {
      const before = structuredClone(rows);
      try {
        return await callback(manager);
      } catch (error) {
        for (const key of Object.keys(rows)) delete rows[key];
        Object.assign(rows, before);
        throw error;
      }
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const dataSource = { manager, transaction } as unknown as DataSource;
  const custody = new PartCustodyService(dataSource);
  const orders = Object.assign(Object.create(ServiceOrdersService.prototype), {
    dataSource,
    auditLogService: new AuditLogService({} as never),
  }) as ServiceOrdersService;
  const parts = Object.assign(Object.create(PartRequestsService.prototype), {
    dataSource,
  }) as PartRequestsService;
  const controller = new PartReturnsController(custody);
  const failRepair = () =>
    orders.reportRepairFailed(
      'order',
      {
        reason: 'beyond_repair',
        parts: [{ partRequestId: 'request', outcome: 'returned' }],
      },
      tech,
    );
  return { rows, manager, custody, orders, parts, controller, failRepair };
}

afterEach(() => vi.unstubAllEnvs());

describe('T3 physical part return audit (in-memory storage)', () => {
  it('AT09: original custodian GET and declare still work after real repair failure releases the assignment', async () => {
    const h = fixture();
    await h.failRepair();
    expect(h.rows.ServiceOrder[0].status).toBe(ServiceOrderStatus.CANCELLED);
    expect(h.rows.TechnicianAssignment[0].isActive).toBe(false);
    expect(h.rows.PartRequest[0].status).toBe(PartRequestStatus.RECEIVED);
    expect(h.rows.PartCustody[0].state).toMatchObject({
      managerAcceptedQty: 0,
      outstandingQty: 3,
      receipts: [],
      declarations: [],
    });
    expect(h.rows.PartCustodyEntry ?? []).toEqual([]);
    expect(await h.controller.byOrder('order', { user: tech })).toMatchObject({
      data: [{ technicianId: tech.id, outstandingQty: 3 }],
    });
    expect(
      await h.controller.declare(
        'request',
        'item',
        command(3, 0, 'declare-terminal'),
        { user: tech },
      ),
    ).toMatchObject({
      data: { declaredQty: 3, managerAcceptedQty: 0, outstandingQty: 3 },
    });
    // Failure's parts choice is a service report, not a physical declaration/receipt.
    expect(h.rows.PartCustodyEntry.map((row) => row.kind)).toEqual([
      'declare_return',
    ]);
    expect(h.rows.PartCustody[0].state.receipts).toEqual([]);
  });

  it('AT09: deassignment and a new active technician cannot transfer the original custody', async () => {
    const h = fixture();
    h.rows.TechnicianAssignment[0].isActive = false;
    h.rows.TechnicianAssignment.push({
      id: 'new-assignment',
      serviceOrderId: 'order',
      technicianId: otherTech.id,
      isActive: true,
    });
    await h.manager.update({ name: 'ServiceOrder' }, 'order', {
      status: ServiceOrderStatus.CANCELLED,
    });
    expect(await h.custody.byOrder('order', tech)).toHaveLength(1);
    await expect(h.custody.byOrder('order', otherTech)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      h.custody.command(
        'request',
        'item',
        'declare_return',
        command(3, 0, 'other-declare'),
        otherTech,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await h.custody.command(
        'request',
        'item',
        'declare_return',
        command(3, 0, 'original-declare'),
        tech,
      ),
    ).toMatchObject({
      technicianId: tech.id,
      managerAcceptedQty: 0,
      outstandingQty: 3,
    });
  });

  it('AT09: SM partial receipt and shortage preserve debt until an explicit final physical receipt', async () => {
    const h = fixture();
    await h.failRepair();
    await h.custody.command(
      'request',
      'item',
      'declare_return',
      command(3, 0, 'declare-three'),
      tech,
    );
    const partial = await h.custody.command(
      'request',
      'item',
      'accept_return',
      command(1, 1, 'accept-one'),
      sm,
    );
    expect(partial).toMatchObject({
      managerAcceptedQty: 1,
      outstandingQty: 2,
      returnStatus: 'partially_received',
    });
    const discrepancy = {
      declaredQty: 2,
      observedQty: 1,
      expectedVersion: 2,
      idempotencyKey: 'shortage-one',
      reason: 'Thiếu một linh kiện',
    };
    expect(
      await h.custody.command(
        'request',
        'item',
        'report_discrepancy',
        discrepancy,
        sm,
      ),
    ).toMatchObject({
      managerAcceptedQty: 1,
      outstandingQty: 2,
      returnStatus: 'exception',
    });
    expect(h.rows.PartCustody[0].state.receipts).toHaveLength(1);
    expect(
      await h.custody.command(
        'request',
        'item',
        'report_discrepancy',
        discrepancy,
        sm,
      ),
    ).toMatchObject({ managerAcceptedQty: 1, outstandingQty: 2, version: 3 });
    const final = await h.custody.command(
      'request',
      'item',
      'accept_return',
      command(2, 3, 'accept-final'),
      sm,
    );
    expect(final).toMatchObject({
      managerAcceptedQty: 3,
      outstandingQty: 0,
      returnStatus: 'received',
      version: 4,
    });
    expect(
      h.rows.PartCustody[0].state.receipts.map((row) => [
        row.quantity,
        row.actorUserId,
        row.actorRole,
      ]),
    ).toEqual([
      [1, sm.id, Role.SERVICE_MANAGER],
      [2, sm.id, Role.SERVICE_MANAGER],
    ]);
    expect(
      h.rows.PartCustody[0].state.receipts.every((row) =>
        Number.isFinite(Date.parse(row.acceptedAt)),
      ),
    ).toBe(true);
    expect(h.rows.ServiceOrder[0]).toMatchObject({
      status: ServiceOrderStatus.CANCELLED,
      grandTotal: 0,
    });
  });

  it.each([Role.ADMIN, Role.CUSTOMER, Role.TECHNICIAN])(
    'AT09: %s cannot physically accept or record discrepancy, at service and route guards',
    async (role) => {
      const h = fixture();
      await h.custody.command(
        'request',
        'item',
        'declare_return',
        command(3, 0, 'declare-three'),
        tech,
      );
      const actor = { id: role === Role.TECHNICIAN ? tech.id : role, role };
      await expect(
        h.custody.command(
          'request',
          'item',
          'accept_return',
          command(1, 1, 'forbidden-accept'),
          actor,
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        h.custody.command(
          'request',
          'item',
          'report_discrepancy',
          {
            declaredQty: 3,
            observedQty: 0,
            expectedVersion: 1,
            idempotencyKey: 'forbidden-shortage',
            reason: 'Thiếu linh kiện',
          },
          actor,
        ),
      ).rejects.toMatchObject({ status: 403 });
      const guard = new RolesGuard(new Reflector());
      for (const handler of [h.controller.accept, h.controller.discrepancy]) {
        const context = {
          getHandler: () => handler,
          getClass: () => PartReturnsController,
          switchToHttp: () => ({ getRequest: () => ({ user: actor }) }),
        } as unknown as ExecutionContext;
        expect(() => guard.canActivate(context)).toThrow();
        const allowed = {
          ...context,
          switchToHttp: () => ({ getRequest: () => ({ user: sm }) }),
        } as unknown as ExecutionContext;
        expect(guard.canActivate(allowed)).toBe(true);
      }
      expect(h.rows.PartCustody[0].state).toMatchObject({
        managerAcceptedQty: 0,
        outstandingQty: 3,
        receipts: [],
      });
    },
  );

  it('AT09: releasing outgoing requests cancels only unreceived stock and never accepts issued stock', async () => {
    const h = fixture();
    h.rows.PartRequest.push(
      ...[
        PartRequestStatus.REQUESTED,
        PartRequestStatus.READY,
        PartRequestStatus.DELIVERING,
      ].map((status) => ({
        id: status,
        serviceOrderId: 'order',
        technicianId: tech.id,
        status,
        qrToken: 'synthetic-token',
      })),
    );
    await releaseOutgoingTechnicianPartRequests(h.manager, 'order', tech.id);
    expect(h.rows.PartRequest.map((row) => row.status)).toEqual([
      PartRequestStatus.RECEIVED,
      PartRequestStatus.CANCELLED,
      PartRequestStatus.CANCELLED,
      PartRequestStatus.CANCELLED,
    ]);
    expect(h.rows.PartCustody[0].state).toMatchObject({
      managerAcceptedQty: 0,
      outstandingQty: 3,
      receipts: [],
    });
    expect(h.rows.PartCustodyEntry ?? []).toEqual([]);
  });

  it('AT14: duplicate concurrent SM receipt records exactly one receipt and replays its original response', async () => {
    const h = fixture();
    await h.custody.command(
      'request',
      'item',
      'declare_return',
      command(3, 0, 'declare-three'),
      tech,
    );
    const body = command(2, 1, 'same-receipt');
    const results = await Promise.all([
      h.custody.command('request', 'item', 'accept_return', body, sm),
      h.custody.command('request', 'item', 'accept_return', body, sm),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(h.rows.PartCustody[0].state).toMatchObject({
      version: 2,
      managerAcceptedQty: 2,
      outstandingQty: 1,
    });
    expect(h.rows.PartCustody[0].state.receipts).toHaveLength(1);
    expect(
      h.rows.PartCustodyEntry.filter((row) => row.kind === 'accept_return'),
    ).toHaveLength(1);
    await h.custody.command(
      'request',
      'item',
      'accept_return',
      command(1, 2, 'last-receipt'),
      sm,
    );
    expect(
      await h.custody.command('request', 'item', 'accept_return', body, sm),
    ).toEqual(results[0]);
    await expect(
      h.custody.command(
        'request',
        'item',
        'accept_return',
        { ...body, quantity: 1 },
        sm,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.rows.PartCustody[0].state).toMatchObject({
      version: 3,
      managerAcceptedQty: 3,
      outstandingQty: 0,
    });
  });

  it('AT14: competing SM keys at the same version accept once; stale command must reload', async () => {
    const h = fixture();
    await h.custody.command(
      'request',
      'item',
      'declare_return',
      command(3, 0, 'declare-three'),
      tech,
    );
    const results = await Promise.allSettled([
      h.custody.command(
        'request',
        'item',
        'accept_return',
        command(2, 1, 'manager-one'),
        sm,
      ),
      h.custody.command(
        'request',
        'item',
        'accept_return',
        command(2, 1, 'manager-two'),
        { id: 'second-manager', role: Role.SERVICE_MANAGER },
      ),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
    });
    expect(h.rows.PartCustody[0].state).toMatchObject({
      managerAcceptedQty: 2,
      outstandingQty: 1,
      version: 2,
    });
    expect(h.rows.PartCustody[0].state.receipts).toHaveLength(1);
    await expect(
      h.custody.command(
        'request',
        'item',
        'accept_return',
        command(2, 2, 'over-remaining'),
        sm,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.rows.PartCustody[0].state).toMatchObject({
      managerAcceptedQty: 2,
      outstandingQty: 1,
    });
  });

  it('keeps used quantities immutable after failure; return APIs do not silently change historical usage', async () => {
    const h = fixture();
    await h.failRepair();
    await expect(
      h.parts.updateItemUsage(
        'request',
        'item',
        { usageStatus: PartUsageStatus.USED },
        tech,
      ),
    ).rejects.toThrow();
    expect(h.rows.PartCustody[0].state).toMatchObject({
      usedQty: 0,
      managerAcceptedQty: 0,
      outstandingQty: 3,
    });
  });

  it('T3b: SM sees a received pre-cohort FixHome item as legacy_manual_review with UNKNOWN receipt and no inferred quantities', async () => {
    const h = fixture();
    h.rows.PartCustody = [];
    const result = await h.controller.legacyManualReview(
      { page: 1, pageSize: 20 },
      { user: sm },
    );
    expect(result.meta).toEqual({ total: 1, page: 1, pageSize: 20 });
    expect(result.data).toEqual([
      {
        kind: 'legacy_manual_review',
        receiptState: 'UNKNOWN',
        orderId: 'order',
        partRequestId: 'request',
        partRequestItemId: 'item',
        technicianId: tech.id,
        requestType: PartRequestType.PRE_REPAIR,
        requestStatus: PartRequestStatus.RECEIVED,
        handedOverAt: '2026-10-20T01:00:00.000Z',
        partCatalogId: 'catalog',
        partNameSnapshot: 'Synthetic part',
        issuedQty: 3,
        manualReviewState: 'UNKNOWN',
        lastManualReview: null,
      },
    ]);
    // Unknown is not zero: no accepted/declared/outstanding count is invented.
    const row = result.data[0] as unknown as Record<string, unknown>;
    for (const key of [
      'acceptedQty',
      'managerAcceptedQty',
      'declaredQty',
      'outstandingQty',
      'usedQty',
    ]) {
      expect(row).not.toHaveProperty(key);
    }
    expect(h.rows.PartCustody).toEqual([]);
  });

  it('T3b: anti-join excludes enrolled custody and mixed requests return only unenrolled FixHome items', async () => {
    const h = fixture();
    // The baseline item is enrolled, so the legacy view is empty.
    expect(
      (
        await h.controller.legacyManualReview(
          { page: 1, pageSize: 20 },
          { user: sm },
        )
      ).data,
    ).toEqual([]);

    const extraItems = [
      {
        id: 'legacy-item',
        partRequestId: 'request',
        partCatalogId: 'catalog-2',
        partSource: PartSource.FIXHOME,
        partNameSnapshot: 'Legacy part',
        quantity: 2,
        usageStatus: PartUsageStatus.RETURNED,
      },
      {
        id: 'technician-item',
        partRequestId: 'request',
        partCatalogId: null,
        partSource: PartSource.TECHNICIAN,
        partNameSnapshot: 'Technician own part',
        quantity: 1,
        usageStatus: PartUsageStatus.USED,
      },
    ];
    h.rows.PartRequestItem.push(...extraItems);
    h.rows.PartRequest[0].items.push(...extraItems);

    const result = await h.controller.legacyManualReview(
      { page: 1, pageSize: 20 },
      { user: sm },
    );
    expect(result.data.map((row) => row.partRequestItemId)).toEqual([
      'legacy-item',
    ]);
    expect(result.data[0]).toMatchObject({
      receiptState: 'UNKNOWN',
      issuedQty: 2,
    });
  });

  it('T3b: only durable received evidence qualifies; unreceived and inconsistent statuses stay out; cancelled keeps its real status', async () => {
    const h = fixture();
    h.rows.PartCustody = [];
    const template = h.rows.PartRequestItem[0];
    const cases: Array<[string, PartRequestStatus, Date | null]> = [
      ['requested', PartRequestStatus.REQUESTED, null],
      ['ready', PartRequestStatus.READY, null],
      ['received-without-date', PartRequestStatus.RECEIVED, null],
      ['cancelled-without-date', PartRequestStatus.CANCELLED, null],
      ['requested-with-date', PartRequestStatus.REQUESTED, new Date('2026-10-01T00:00:00Z')],
      ['completed', PartRequestStatus.COMPLETED, new Date('2026-10-02T00:00:00Z')],
      ['cancelled-received', PartRequestStatus.CANCELLED, new Date('2026-10-05T00:00:00Z')],
    ];
    for (const [id, status, receivedAt] of cases) {
      h.rows.PartRequest.push({
        id,
        serviceOrderId: 'order',
        technicianId: tech.id,
        requestType: PartRequestType.PRE_REPAIR,
        status,
        receivedAt,
      });
      h.rows.PartRequestItem.push({
        ...template,
        id: `${id}-item`,
        partRequestId: id,
      });
    }

    const result = await h.controller.legacyManualReview(
      { page: 1, pageSize: 20 },
      { user: sm },
    );
    expect(result.data.map((row) => row.partRequestItemId)).toEqual([
      'completed-item',
      'cancelled-received-item',
      'item',
    ]);
    expect(
      result.data.find(
        (row) => row.partRequestItemId === 'cancelled-received-item',
      )?.requestStatus,
    ).toBe(PartRequestStatus.CANCELLED);
    for (const excluded of [
      'requested-item',
      'ready-item',
      'received-without-date-item',
      'cancelled-without-date-item',
      'requested-with-date-item',
    ]) {
      expect(
        result.data.some((row) => row.partRequestItemId === excluded),
      ).toBe(false);
    }
  });

  it.each([Role.ADMIN, Role.CUSTOMER, Role.TECHNICIAN])(
    'T3b: %s cannot read the legacy manual-review list at service and route guards',
    async (role) => {
      const h = fixture();
      h.rows.PartCustody = [];
      const actor = {
        id: role === Role.TECHNICIAN ? tech.id : role,
        role,
      };
      await expect(
        h.custody.legacyManualReview(actor, 1, 20),
      ).rejects.toMatchObject({ status: 403 });

      const guard = new RolesGuard(new Reflector());
      const context = {
        getHandler: () => h.controller.legacyManualReview,
        getClass: () => PartReturnsController,
        switchToHttp: () => ({ getRequest: () => ({ user: actor }) }),
      } as unknown as ExecutionContext;
      expect(() => guard.canActivate(context)).toThrow();
      const allowed = {
        ...context,
        switchToHttp: () => ({ getRequest: () => ({ user: sm }) }),
      } as unknown as ExecutionContext;
      expect(guard.canActivate(allowed)).toBe(true);
    },
  );

  it('T3b: legacy review is bounded, paginated and deterministically ordered by handover time then item id', async () => {
    const h = fixture();
    h.rows.PartCustody = [];
    const template = h.rows.PartRequestItem[0];
    h.rows.PartRequestItem = [
      { ...template, id: 'c-item', partRequestId: 'c' },
      { ...template, id: 'a-item', partRequestId: 'a' },
      { ...template, id: 'b-item', partRequestId: 'b' },
    ];
    h.rows.PartRequest = [
      {
        id: 'c',
        serviceOrderId: 'order',
        technicianId: tech.id,
        requestType: PartRequestType.PRE_REPAIR,
        status: PartRequestStatus.RECEIVED,
        receivedAt: new Date('2026-10-03T00:00:00Z'),
      },
      {
        id: 'a',
        serviceOrderId: 'order',
        technicianId: tech.id,
        requestType: PartRequestType.PRE_REPAIR,
        status: PartRequestStatus.RECEIVED,
        receivedAt: new Date('2026-10-01T00:00:00Z'),
      },
      {
        id: 'b',
        serviceOrderId: 'order',
        technicianId: tech.id,
        requestType: PartRequestType.PRE_REPAIR,
        status: PartRequestStatus.RECEIVED,
        receivedAt: new Date('2026-10-02T00:00:00Z'),
      },
    ];

    const first = await h.controller.legacyManualReview(
      { page: 1, pageSize: 2 },
      { user: sm },
    );
    expect(first.meta).toEqual({ total: 3, page: 1, pageSize: 2 });
    expect(first.data.map((row) => row.partRequestItemId)).toEqual([
      'a-item',
      'b-item',
    ]);
    const second = await h.controller.legacyManualReview(
      { page: 2, pageSize: 2 },
      { user: sm },
    );
    expect(second.meta).toEqual({ total: 3, page: 2, pageSize: 2 });
    expect(second.data.map((row) => row.partRequestItemId)).toEqual([
      'c-item',
    ]);
    const capped = await h.controller.legacyManualReview(
      { page: 1, pageSize: 999 },
      { user: sm },
    );
    expect(capped.meta.pageSize).toBe(100);
  });

  it('T3b: SM cannot turn a legacy unknown into a receipt through accept-return', async () => {
    const h = fixture();
    h.rows.PartCustody = [];
    const legacy = await h.controller.legacyManualReview(
      { page: 1, pageSize: 20 },
      { user: sm },
    );
    expect(legacy.data[0]).toMatchObject({
      kind: 'legacy_manual_review',
      receiptState: 'UNKNOWN',
    });
    await expect(
      h.custody.command(
        'request',
        'item',
        'accept_return',
        command(1, 0, 'legacy-accept'),
        sm,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.rows.PartCustody).toEqual([]);
    expect(h.rows.PartCustodyEntry ?? []).toEqual([]);
  });

  it('AT10 GAP reproduction: pre-cohort received legacy stock disappears from the SM queue; empty is not return proof', async () => {
    const h = fixture();
    h.rows.PartCustody = [];
    h.rows.PartRequest[0].receivedAt = new Date('2026-10-01T01:00:00Z');
    await h.failRepair();
    expect(h.rows.PartRequest[0]).toMatchObject({
      status: PartRequestStatus.RECEIVED,
      technicianId: tech.id,
    });
    expect(await h.custody.pending(sm)).toEqual([]);
    expect(await h.custody.byOrder('order', sm)).toEqual([]);
    await expect(h.custody.byOrder('order', tech)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      h.custody.command(
        'request',
        'item',
        'declare_return',
        command(3, 0, 'legacy-declare'),
        tech,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.rows.PartCustody).toEqual([]);
    expect(h.rows.PartCustodyEntry ?? []).toEqual([]);
    // This characterizes an unresolved requirement, NOT successful legacy return support.
    // See docs/PLATFORM-FIRST-T3-PARTS-AUDIT.md for the read-only Web contract blocker.
  });

  it.each(['installed', 'returned'] as const)(
    'documents the T1 failure-contract boundary: mixed used/return quantities cannot be closed as %s',
    async (outcome) => {
      const h = fixture();
      h.rows.PartRequest[0].items[0].usageStatus = PartUsageStatus.USED;
      h.rows.PartCustody[0].state = createPartCustodySnapshot({
        serviceOrderId: 'order',
        partRequestId: 'request',
        partRequestItemId: 'item',
        requestType: PartRequestType.PRE_REPAIR,
        additionalCostId: null,
        partCatalogId: 'catalog',
        source: PartSource.FIXHOME,
        originalCustodianTechnicianId: tech.id,
        issuedQty: 3,
        usedQty: 1,
        serviceOrderStatus: ServiceOrderStatus.UNDER_REPAIR,
        invoiceFrozen: false,
      });
      await expect(
        h.orders.reportRepairFailed(
          'order',
          {
            reason: 'beyond_repair',
            parts: [{ partRequestId: 'request', outcome }],
          },
          tech,
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(h.rows.ServiceOrder[0].status).toBe(
        ServiceOrderStatus.UNDER_REPAIR,
      );
      expect(h.rows.TechnicianAssignment[0].isActive).toBe(true);
      expect(h.rows.PartCustody[0].state).toMatchObject({
        usedQty: 1,
        managerAcceptedQty: 0,
        outstandingQty: 2,
        receipts: [],
      });
      expect(h.rows.SupportCase ?? []).toEqual([]);
    },
  );
});

describe('T11 legacy physical observations (in-memory storage, not PostgreSQL)', () => {
  const body = (patch: Record<string, unknown> = {}) => ({
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expectedVersion: 0,
    status: 'INVESTIGATING', reason: 'Đối chiếu chứng từ bàn giao cũ', ...patch,
  });
  const setup = () => {
    const h = fixture();
    h.rows.PartCustody = [];
    return h;
  };
  const review = (h: ReturnType<typeof fixture>, patch = {}, actor = sm, itemId = 'item') =>
    (h.custody as any).reviewLegacyItem(itemId, body(patch), actor);

  it('persists an immutable observation, replays it after later observations, and never accepts stock', async () => {
    const h = setup();
    expect((h.custody as any).reviewLegacyItem).toBeTypeOf('function');
    const before = structuredClone(h.rows);
    const first = await review(h);
    expect(first).toMatchObject({ receiptState: 'UNKNOWN', manualReviewState: 'INVESTIGATING',
      lastManualReview: { version: 1, actorUserId: sm.id, actorRole: Role.SERVICE_MANAGER,
        orderId: 'order', technicianId: tech.id, partRequestId: 'request', partRequestItemId: 'item' } });
    const final = await review(h, { commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedVersion: 1,
      status: 'PHYSICALLY_VERIFIED', observedQty: 2, evidenceReferenceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    expect(final).toMatchObject({ receiptState: 'UNKNOWN', manualReviewState: 'PHYSICALLY_VERIFIED', lastManualReview: { observedQty: 2 } });
    expect(await review(h, { commandId: body().commandId.toUpperCase() })).toEqual(first);
    expect(h.rows.AuditLog).toHaveLength(2);
    expect(h.rows.AuditLog[0]).toMatchObject({ action: 'SM_LEGACY_PARTS_MANUAL_REVIEW', resourceType: 'part_request_item', resourceId: 'item' });
    const listed = await h.custody.legacyManualReview(sm);
    expect(listed.data[0]).toMatchObject(final);
    for (const key of ['managerAcceptedQty', 'acceptedQty', 'outstandingQty', 'usedQty']) expect(listed.data[0]).not.toHaveProperty(key);
    for (const [key, rows] of Object.entries(before)) expect(h.rows[key]).toEqual(rows);
  });

  it.each([Role.ADMIN, Role.CUSTOMER, Role.TECHNICIAN])('rejects %s in service and route guard', async role => {
    const h = setup();
    await expect(review(h, {}, { id: role, role })).rejects.toMatchObject({ status: 403 });
    const guard = new RolesGuard(new Reflector());
    const ctx = { getHandler: () => (h.controller as any).reviewLegacyItem, getClass: () => PartReturnsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: role, role } }) }) } as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow();
    expect(h.rows.AuditLog ?? []).toEqual([]);
  });

  it('rejects missing items, non-FixHome sources, missing/fake handovers and enrolled custody', async () => {
    await expect(review(setup(), {}, sm, 'other-item')).rejects.toMatchObject({ status: 404 });
    for (const mutate of [
      h => { h.rows.PartRequestItem[0].partSource = PartSource.TECHNICIAN; },
      h => { h.rows.PartRequest[0].receivedAt = null; },
      h => { h.rows.PartRequest[0].receivedAt = new Date('invalid'); },
      h => { h.rows.PartRequest[0].status = PartRequestStatus.READY; },
      h => { h.rows.PartRequestItem[0].partRequestId = 'wrong-request'; },
      h => { h.rows.PartRequest[0].serviceOrderId = 'wrong-order'; },
      h => { h.rows.PartCustody = [{ partRequestItemId: 'item' }]; },
    ]) {
      const h = setup(); mutate(h);
      await expect(review(h)).rejects.toMatchObject({ status: 409 });
      expect(h.rows.AuditLog ?? []).toEqual([]);
    }
  });

  it('rejects changed replay, stale competing observations and final overwrite without documented correction', async () => {
    const h = setup();
    const outcomes = await Promise.allSettled([review(h), review(h, { commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })]);
    expect(outcomes.map(row => row.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((outcomes.find(row => row.status === 'rejected') as PromiseRejectedResult).reason.status).toBe(409);
    await expect(review(h, { reason: 'Nội dung bị thay đổi' })).rejects.toMatchObject({ status: 409 });
    await expect(review(h, {}, { id: 'other-manager', role: Role.SERVICE_MANAGER })).rejects.toMatchObject({ status: 409 });
    const final = await review(h, { commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expectedVersion: 1,
      status: 'DISCREPANCY_RECORDED' });
    const correction = { commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', expectedVersion: 2,
      status: 'PHYSICALLY_VERIFIED', evidenceReferenceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
    await expect(review(h, correction)).rejects.toMatchObject({ status: 409 });
    await expect(review(h, { ...correction, correctsEventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', correctionReason: 'Có chứng từ đối chiếu bổ sung' })).rejects.toMatchObject({ status: 409 });
    const corrected = await review(h, { ...correction, correctsEventId: final.lastManualReview.id,
      correctionReason: 'Có chứng từ đối chiếu bổ sung' });
    expect(corrected.lastManualReview).toMatchObject({ version: 3, correctsEventId: final.lastManualReview.id });
    expect(h.rows.AuditLog).toHaveLength(3);
    expect(h.rows.AuditLog[1].after.event.status).toBe('DISCREPANCY_RECORDED');
  });

  it('allows observations on stopped/deassigned old work without changing booking, finances or assignments', async () => {
    const h = setup();
    h.rows.ServiceOrder[0].status = ServiceOrderStatus.CANCELLED;
    h.rows.TechnicianAssignment[0].isActive = false;
    h.rows.PartRequest[0].status = PartRequestStatus.CANCELLED;
    const before = structuredClone(h.rows);
    await review(h);
    for (const [key, rows] of Object.entries(before)) expect(h.rows[key]).toEqual(rows);
    expect(h.rows.PartCustody).toEqual([]);
  });

  it('rolls back on audit failure and rejects malformed prior proof', async () => {
    const h = setup();
    const insert = h.manager.insert;
    h.manager.insert = async entity => { if (entity === AuditLog) throw new Error('audit unavailable'); };
    await expect(review(h)).rejects.toThrow('audit unavailable');
    expect(h.rows.AuditLog ?? []).toEqual([]);
    h.manager.insert = insert;
    await review(h);
    h.rows.AuditLog[0].after.event.technicianId = 'wrong-technician';
    await expect(review(h)).rejects.toMatchObject({ status: 409 });
    await expect(h.custody.legacyManualReview(sm)).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    { commandId: 'invalid' }, { expectedVersion: -1 }, { expectedVersion: 0.5 }, { status: 'ACCEPTED' },
    { reason: '    ' }, { reason: 'x'.repeat(301) }, { reason: 'https://example.test/evidence' },
    { reason: 'person@example.test' }, { evidenceReferenceId: 'https://example.test/evidence' },
    { evidenceReferenceId: null }, { observedQty: -1 }, { observedQty: 101 }, { observedQty: 1.5 },
    { observedQty: 1 }, { observedQty: null }, { observedQty: 1, evidenceReferenceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    { status: 'PHYSICALLY_VERIFIED' }, { correctsEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    { correctionReason: 'Không có bản trước' }, { receivedAt: '2026-10-20' }, { managerAcceptedQty: 2 },
  ])('rejects invalid/bounded evidence or invented physical authority %o', async patch => {
    const h = setup();
    await expect(review(h, patch)).rejects.toMatchObject({ status: 400 });
    expect(h.rows.AuditLog ?? []).toEqual([]);
  });
});
