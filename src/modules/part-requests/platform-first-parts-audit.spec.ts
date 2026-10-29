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
