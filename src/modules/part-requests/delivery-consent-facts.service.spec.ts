import { describe, expect, it, vi } from 'vitest';
import { Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { PartRequest } from './entities/part-request.entity';
import { DeliveryConsentFactsService } from './delivery-consent-facts.service';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mandatory = [
  'SHIPPING_APPROVAL_SOURCE_UNVERIFIED',
  'WAREHOUSE_DELIVERY_ALLOCATION_MISSING',
  'COURIER_PROOF_UNVERIFIED',
  'FINANCE_CUTOVER_CLOSED',
  'TOTAL_ORDER_LABOR_BUDGET_UNVERIFIED',
];
function fixture() {
  const customer = {
    id: id(1),
    role: Role.CUSTOMER,
    isActive: true,
    status: 'active',
    passwordHash: 'must-not-read',
  };
  const technician = {
    id: id(2),
    role: Role.TECHNICIAN,
    isActive: true,
    status: 'active',
  };
  const sm = {
    id: id(3),
    role: Role.SERVICE_MANAGER,
    isActive: true,
    status: 'active',
  };
  const admin = {
    id: id(4),
    role: Role.ADMIN,
    isActive: true,
    status: 'active',
  };
  const booking = { id: id(5), customerId: customer.id };
  const order = {
    id: id(6),
    bookingId: booking.id,
    status: 'under_repair',
    completionRequestedAt: null,
    laborTotal: 999_999_999,
  };
  const assignment = {
    id: id(7),
    serviceOrderId: order.id,
    technicianId: technician.id,
    isActive: true,
  };
  const source = {
    id: id(8),
    serviceOrderId: order.id,
    technicianId: technician.id,
    status: 'approved',
    decidedAt: new Date('2026-11-05T00:00:00Z'),
    decidedByCustomerId: customer.id,
    shippingFee: 20_000,
    evidenceUrls: ['private-do-not-read'],
  };
  const request = {
    id: id(9),
    serviceOrderId: order.id,
    technicianId: technician.id,
    requestType: 'additional',
    fulfillmentMethod: 'delivery',
    status: 'requested',
    additionalCostId: source.id,
    quotationId: null,
    shippingFee: 20_000,
    qrToken: 'private-qr',
  };
  const invoice = { id: id(10), serviceOrderId: order.id, grandTotal: 123_456 };
  const tables = new Map<any, any[]>([
    [User, [customer, technician, sm, admin]],
    [Booking, [booking]],
    [ServiceOrder, [order]],
    [TechnicianAssignment, [assignment]],
    [AdditionalCostRequest, [source]],
    [PartRequest, [request]],
    [Invoice, []],
    [Quotation, []],
  ]);
  const match = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([key, value]) => row[key] === value);
  const double = {
    findOne: vi.fn(async (entity: any, options: any) => {
      if (options?.lock) throw new Error('Preview must not acquire locks');
      const row = tables.get(entity)?.find((r) => match(r, options?.where));
      if (!row) return null;
      if (!Array.isArray(options.select))
        throw new Error('Explicit minimal select required');
      return Object.fromEntries(
        options.select.map((key: string) => [key, structuredClone(row[key])]),
      );
    }),
    existsBy: vi.fn(
      async (entity: any, where: any) =>
        !!tables.get(entity)?.some((r) => match(r, where)),
    ),
    insert: vi.fn(() => {
      throw new Error('write forbidden');
    }),
    update: vi.fn(() => {
      throw new Error('write forbidden');
    }),
    transaction: vi.fn(() => {
      throw new Error('transaction forbidden');
    }),
    query: vi.fn(() => {
      throw new Error('raw query forbidden');
    }),
  };
  const manager: any = double;
  const service = new DeliveryConsentFactsService();
  const principal = (user: any) => ({ id: user.id, role: user.role });
  const preview = (user: { id: string; role: Role } = customer) =>
    service.preview(manager, request.id, principal(user));
  return {
    customer,
    technician,
    sm,
    admin,
    booking,
    order,
    assignment,
    source,
    request,
    invoice,
    tables,
    manager,
    service,
    principal,
    preview,
  };
}

describe('B2a unmounted, non-atomic delivery owner facts preview', () => {
  it.each(['customer', 'technician'])(
    'reads identifiers only for the %s ownership gate and scopes every later facts fetch',
    async (role) => {
      const f = fixture();
      await f.preview(role === 'customer' ? f.customer : f.technician);
      const calls = f.manager.findOne.mock.calls as [any, any][];
      const expected = [
        [User, ['id', 'role', 'isActive', 'status']],
        [PartRequest, ['id', 'serviceOrderId', 'technicianId']],
        [ServiceOrder, ['id', 'bookingId']],
        [Booking, ['id', 'customerId']],
        [
          TechnicianAssignment,
          ['id', 'serviceOrderId', 'technicianId', 'isActive'],
        ],
      ];
      if (role === 'customer')
        expected.push([User, ['id', 'role', 'isActive', 'status']]);
      for (let i = 0; i < expected.length; i++) {
        expect(calls[i][0]).toBe(expected[i][0]);
        expect(calls[i][1].select).toEqual(expected[i][1]);
      }
      const requestReads = calls.filter(([entity]) => entity === PartRequest);
      const orderReads = calls.filter(([entity]) => entity === ServiceOrder);
      expect(requestReads).toHaveLength(2);
      expect(orderReads).toHaveLength(2);
      expect(requestReads[1][1].where).toEqual({
        id: f.request.id,
        serviceOrderId: f.order.id,
        technicianId: f.technician.id,
      });
      expect(orderReads[1][1].where).toEqual({
        id: f.order.id,
        bookingId: f.booking.id,
      });
      expect(requestReads[1][1].select).not.toEqual(
        expect.arrayContaining(['shippingFee']),
      );
      expect(orderReads[1][1].select).not.toEqual(
        expect.arrayContaining(['laborTotal']),
      );
      const sourceIndex = calls.findIndex(
        ([entity]) => entity === AdditionalCostRequest,
      );
      expect(sourceIndex).toBeGreaterThan(calls.indexOf(requestReads[1]));
      expect(sourceIndex).toBeGreaterThan(calls.indexOf(orderReads[1]));
    },
  );
  it.each([
    'request_deleted',
    'request_order',
    'request_technician',
    'order_deleted',
    'order_booking',
    'booking_customer',
    'booking_deleted',
    'assignment_replaced',
    'assignment_revoked',
    'actor_revoked',
    'technician_revoked',
  ])(
    'fails closed before source/invoice if scope changes between gate and fresh reads: %s',
    async (issue) => {
      const f = fixture();
      const original = f.manager.findOne.getMockImplementation();
      let firstScopeCompleted = false;
      f.manager.findOne.mockImplementation(
        async (entity: any, options: any) => {
          const row = await original(entity, options);
          // Customer's technician read is the last read of the first ownership gate.
          // The returned row is already detached, simulating a concurrent change after that read.
          if (
            !firstScopeCompleted &&
            entity === User &&
            options.where.id === f.technician.id
          ) {
            firstScopeCompleted = true;
            if (issue === 'request_deleted') f.tables.set(PartRequest, []);
            if (issue === 'request_order') f.request.serviceOrderId = id(91);
            if (issue === 'request_technician') f.request.technicianId = id(91);
            if (issue === 'order_deleted') f.tables.set(ServiceOrder, []);
            if (issue === 'order_booking') f.order.bookingId = id(91);
            if (issue === 'booking_customer') f.booking.customerId = id(91);
            if (issue === 'booking_deleted') f.tables.set(Booking, []);
            if (issue === 'assignment_replaced') {
              f.assignment.isActive = false;
              f.tables
                .get(TechnicianAssignment)!
                .push({ ...f.assignment, id: id(92), isActive: true });
            }
            if (issue === 'assignment_revoked') f.assignment.isActive = false;
            if (issue === 'actor_revoked') f.customer.isActive = false;
            if (issue === 'technician_revoked') f.technician.isActive = false;
          }
          return row;
        },
      );
      await expect(f.preview()).rejects.toThrow(/^NOT_FOUND_OR_DENIED$/);
      expect(firstScopeCompleted).toBe(true);
      expect(
        f.manager.findOne.mock.calls.some(
          ([entity]: any) =>
            entity === AdditionalCostRequest || entity === Quotation,
        ),
      ).toBe(false);
      expect(f.manager.existsBy).not.toHaveBeenCalled();
      expect(f.manager.insert).not.toHaveBeenCalled();
      expect(f.manager.update).not.toHaveBeenCalled();
      expect(f.manager.transaction).not.toHaveBeenCalled();
      expect(f.manager.query).not.toHaveBeenCalled();
    },
  );
  it.each(['customer', 'technician'])(
    'returns only redacted server facts to current own %s, with every action blocked',
    async (role) => {
      const f = fixture();
      const user = role === 'customer' ? f.customer : f.technician;
      const result = await f.preview(user);
      expect(result).toMatchObject({
        mode: 'NON_EXECUTABLE_PREVIEW',
        consistency: 'NON_ATOMIC',
        actor: f.principal(user),
        requestId: f.request.id,
        serviceOrderId: f.order.id,
        source: {
          kind: 'ADDITIONAL_COST',
          partsLaborApproval: 'VERIFIED_APPROVED',
          shippingApproval: 'UNVERIFIED',
        },
        actions: {
          newConsent: 'BLOCKED',
          proposal: 'BLOCKED',
          dispatch: 'BLOCKED',
          payout: 'BLOCKED',
        },
      });
      expect(result.blockers).toEqual(mandatory);
      const json = JSON.stringify(result);
      for (const value of [
        'private-do-not-read',
        'private-qr',
        'passwordHash',
        'shippingFee',
        'laborTotal',
        'grandTotal',
        f.source.id,
      ])
        expect(json).not.toContain(value);
      expect(f.manager.insert).not.toHaveBeenCalled();
      expect(f.manager.update).not.toHaveBeenCalled();
      expect(f.manager.transaction).not.toHaveBeenCalled();
      expect(f.manager.query).not.toHaveBeenCalled();
      expect(
        f.manager.findOne.mock.calls.some(
          ([entity]: any) => entity === Invoice,
        ),
      ).toBe(false);
      expect(f.manager.existsBy).toHaveBeenCalledWith(Invoice, {
        serviceOrderId: f.order.id,
      });
      const allowed = new Set([
        User,
        Booking,
        ServiceOrder,
        TechnicianAssignment,
        PartRequest,
        AdditionalCostRequest,
      ]);
      for (const [entity, options] of f.manager.findOne.mock.calls) {
        expect(allowed.has(entity)).toBe(true);
        expect(options.lock).toBeUndefined();
        expect(options.select).not.toEqual(
          expect.arrayContaining(['shippingFee']),
        );
      }
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.blockers)).toBe(true);
    },
  );
  it.each([
    'missing_request',
    'missing_order',
    'missing_booking',
    'cross_customer',
    'cross_tech',
    'role_mismatch',
    'inactive',
    'suspended',
    'revoked',
    'wrong_assignment',
    'wrong_request_tech',
  ])(
    'returns uniform denial with no source/invoice/private reads for %s',
    async (issue) => {
      const f = fixture();
      let actor: any = f.principal(f.customer);
      if (issue === 'missing_request') f.tables.set(PartRequest, []);
      if (issue === 'missing_order') f.request.serviceOrderId = id(90);
      if (issue === 'missing_booking') f.order.bookingId = id(90);
      if (issue === 'cross_customer') f.booking.customerId = id(90);
      if (issue === 'cross_tech')
        actor = { id: f.customer.id, role: Role.TECHNICIAN };
      if (issue === 'role_mismatch') f.customer.role = Role.ADMIN;
      if (issue === 'inactive') f.customer.isActive = false;
      if (issue === 'suspended') f.customer.status = 'suspended';
      if (issue === 'revoked') f.assignment.isActive = false;
      if (issue === 'wrong_assignment') f.assignment.serviceOrderId = id(90);
      if (issue === 'wrong_request_tech') f.request.technicianId = id(90);
      await expect(
        f.service.preview(f.manager, f.request.id, actor),
      ).rejects.toThrow(/^NOT_FOUND_OR_DENIED$/);
      expect(f.manager.existsBy).not.toHaveBeenCalled();
      expect(
        f.manager.findOne.mock.calls.some(
          ([entity]: any) =>
            entity === AdditionalCostRequest || entity === Quotation,
        ),
      ).toBe(false);
    },
  );
  it.each(['sm', 'admin'])(
    'refuses %s consent/proposal and wide preview before reading the request',
    async (name) => {
      const f = fixture();
      const actor = name === 'sm' ? f.sm : f.admin;
      await expect(f.preview(actor)).rejects.toThrow(/^NOT_FOUND_OR_DENIED$/);
      expect(f.manager.findOne).toHaveBeenCalledTimes(1);
      expect(f.manager.findOne.mock.calls[0][0]).toBe(User);
      expect(f.manager.existsBy).not.toHaveBeenCalled();
    },
  );
  it.each([
    'other_active_technician',
    'revoked',
    'inactive',
    'suspended',
    'role_changed',
  ])(
    'denies real technician principals when scope/user is %s',
    async (issue) => {
      const f = fixture();
      const actor = f.principal(f.technician);
      if (issue === 'other_active_technician') {
        actor.id = id(90);
        f.tables.get(User)!.push({
          id: id(90),
          role: Role.TECHNICIAN,
          isActive: true,
          status: 'active',
        });
      }
      if (issue === 'revoked') f.assignment.isActive = false;
      if (issue === 'inactive') f.technician.isActive = false;
      if (issue === 'suspended') f.technician.status = 'suspended';
      if (issue === 'role_changed') f.technician.role = Role.ADMIN;
      await expect(
        f.service.preview(f.manager, f.request.id, actor),
      ).rejects.toThrow(/^NOT_FOUND_OR_DENIED$/);
      expect(f.manager.existsBy).not.toHaveBeenCalled();
      expect(
        f.manager.findOne.mock.calls.some(
          ([entity]: any) =>
            entity === AdditionalCostRequest || entity === Quotation,
        ),
      ).toBe(false);
    },
  );
  it.each(['cancelled', 'completed'])(
    'keeps own preview blocked for order %s',
    async (status) => {
      const f = fixture();
      f.order.status = status;
      expect((await f.preview()).blockers).toContain('ORDER_FROZEN');
    },
  );
  it('uses only invoice existence and completion intent as frozen blockers', async () => {
    const f = fixture();
    f.order.completionRequestedAt = new Date();
    f.tables.set(Invoice, [f.invoice]);
    const result = await f.preview();
    expect(result.blockers).toEqual(
      expect.arrayContaining(['ORDER_FROZEN', 'ORDER_INVOICED']),
    );
    expect(JSON.stringify(result)).not.toContain(f.invoice.id);
    expect(JSON.stringify(result)).not.toContain('123456');
  });
  it.each(['cancelled', 'completed', 'received', 'delivering'])(
    'blocks new consent for request status %s',
    async (status) => {
      const f = fixture();
      f.request.status = status;
      expect((await f.preview()).blockers).toContain('REQUEST_FROZEN');
    },
  );
  it.each(['pickup', 'warranty', 'pre_repair'])(
    'does not promote legacy/unsupported request %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'pickup') f.request.fulfillmentMethod = 'pickup';
      else f.request.requestType = kind;
      const result = await f.preview();
      expect(result.blockers).toContain(
        kind === 'pickup'
          ? 'FULFILLMENT_NOT_DELIVERY'
          : 'REQUEST_KIND_UNSUPPORTED',
      );
      expect(result.actions.newConsent).toBe('BLOCKED');
    },
  );
  it.each(['pending_approval', 'rejected'])(
    'distinguishes %s parts/labor source from shipping approval',
    async (status) => {
      const f = fixture();
      f.source.status = status;
      const result = await f.preview();
      expect(result.source.partsLaborApproval).toBe('NOT_APPROVED');
      expect(result.blockers).toEqual(
        expect.arrayContaining([
          ...mandatory,
          'PARTS_LABOR_SOURCE_NOT_APPROVED',
        ]),
      );
    },
  );
  it.each([
    'source_order',
    'source_tech',
    'deciding_customer',
    'missing_source',
    'both_sources',
    'wrong_kind',
    'missing_decision',
  ])('never treats mismatched approval %s as verified', async (issue) => {
    const f = fixture();
    if (issue === 'source_order') f.source.serviceOrderId = id(90);
    if (issue === 'source_tech') f.source.technicianId = id(90);
    if (issue === 'deciding_customer') f.source.decidedByCustomerId = id(90);
    if (issue === 'missing_source') f.request.additionalCostId = id(90);
    if (issue === 'both_sources') f.request.quotationId = id(90);
    if (issue === 'wrong_kind') {
      f.request.additionalCostId = null;
      f.request.quotationId = id(90);
    }
    if (issue === 'missing_decision') f.source.decidedAt = null;
    const result = await f.preview();
    expect(result.source.partsLaborApproval).not.toBe('VERIFIED_APPROVED');
    expect(result.blockers).toContain('SOURCE_BINDING_UNVERIFIED');
    expect(result.actions.payout).toBe('BLOCKED');
  });
  it('verifies approved Quotation parts/labor version but never its nonexistent shipping approval', async () => {
    const f = fixture();
    f.request.requestType = 'quotation';
    f.request.additionalCostId = null;
    f.request.quotationId = id(11);
    f.tables.set(Quotation, [
      {
        id: id(11),
        serviceOrderId: f.order.id,
        technicianId: f.technician.id,
        status: 'approved',
        version: 2,
        decidedAt: new Date(),
      },
    ]);
    const result = await f.preview();
    expect(result.source).toEqual({
      kind: 'QUOTATION',
      partsLaborApproval: 'VERIFIED_APPROVED',
      shippingApproval: 'UNVERIFIED',
      version: 2,
    });
    expect(result.blockers).toEqual(mandatory);
    expect(result.actions.newConsent).toBe('BLOCKED');
  });
  it('propagates storage failure instead of inventing facts or classifying it as access denial', async () => {
    const f = fixture();
    f.manager.findOne.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(f.preview()).rejects.toThrow('database unavailable');
  });
  it('rejects malformed IDs/principals before a database query', async () => {
    const f = fixture();
    for (const actor of [
      undefined,
      {},
      { id: f.customer.id },
      { ...f.principal(f.customer), shippingFee: 1 },
    ])
      await expect(
        f.service.preview(f.manager, f.request.id, actor),
      ).rejects.toThrow(/^NOT_FOUND_OR_DENIED$/);
    await expect(
      f.service.preview(f.manager, 'not-uuid', f.principal(f.customer)),
    ).rejects.toThrow(/^NOT_FOUND_OR_DENIED$/);
    expect(f.manager.findOne).not.toHaveBeenCalled();
  });
});
