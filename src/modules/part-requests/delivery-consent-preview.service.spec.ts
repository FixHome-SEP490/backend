import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { PartRequest } from './entities/part-request.entity';
import { DeliveryConsentPreviewService } from './delivery-consent-preview.service';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const customer = {
    id: id(1),
    role: Role.CUSTOMER,
    status: 'active',
    isActive: true,
  };
  const technician = { ...customer, id: id(2), role: Role.TECHNICIAN };
  const booking = { id: id(3), customerId: customer.id };
  const order = {
    id: id(4),
    bookingId: booking.id,
    status: 'under_repair',
    completionRequestedAt: null,
  };
  const assignment = {
    id: id(5),
    serviceOrderId: order.id,
    technicianId: technician.id,
    isActive: true,
  };
  const request = {
    id: id(6),
    serviceOrderId: order.id,
    technicianId: technician.id,
    requestType: 'additional',
    status: 'requested',
    fulfillmentMethod: 'delivery',
    quotationId: null,
    additionalCostId: null,
  };
  const rows = new Map<any, any[]>([
    [User, [customer, technician]],
    [Booking, [booking]],
    [ServiceOrder, [order]],
    [TechnicianAssignment, [assignment]],
    [PartRequest, [request]],
  ]);
  // UNIT read dependencies only; never a database/runtime substitute.
  const manager = {
    findOne: vi.fn(async (entity: any, options: any) => {
      const row = rows
        .get(entity)
        ?.find((r) =>
          Object.entries(options.where).every(([k, v]) => r[k] === v),
        );
      return row
        ? Object.fromEntries(options.select.map((k: string) => [k, row[k]]))
        : null;
    }),
    existsBy: vi.fn(async () => false),
  };
  const service = new DeliveryConsentPreviewService({ manager } as any);
  return {
    service,
    manager,
    customer,
    technician,
    booking,
    assignment,
    request,
    rows,
  };
}
const principal = (user: { id: string; role: Role }) => ({
  id: user.id,
  role: user.role,
});

describe('DeliveryConsentPreviewService (unit reads, no HTTP/DB)', () => {
  it.each(['customer', 'technician'] as const)(
    'returns a blocked preview for the actual %s owner',
    async (key) => {
      const f = fixture();
      const result = await f.service.preview(f.request.id, principal(f[key]));
      expect(result).toMatchObject({
        mode: 'NON_EXECUTABLE_PREVIEW',
        consistency: 'NON_ATOMIC',
        actor: principal(f[key]),
        requestId: f.request.id,
        source: { shippingApproval: 'UNVERIFIED' },
        actions: {
          newConsent: 'BLOCKED',
          proposal: 'BLOCKED',
          dispatch: 'BLOCKED',
          payout: 'BLOCKED',
        },
      });
      expect(result.blockers).toEqual(
        expect.arrayContaining([
          'FINANCE_CUTOVER_CLOSED',
          'SHIPPING_APPROVAL_SOURCE_UNVERIFIED',
          'WAREHOUSE_DELIVERY_ALLOCATION_MISSING',
          'COURIER_PROOF_UNVERIFIED',
          'TOTAL_ORDER_LABOR_BUDGET_UNVERIFIED',
        ]),
      );
      expect(f.manager.existsBy).toHaveBeenCalledOnce();
    },
  );

  it.each([
    'missing',
    'foreign-customer',
    'foreign-technician',
    'inactive',
    'stale-role',
    'revoked-assignment',
    'changed-owner',
    'admin',
    'manager',
    'extra-authority',
  ])('returns the same 404 for %s', async (kind) => {
    const f = fixture();
    let actor: any = principal(f.customer);
    if (kind === 'missing') f.rows.set(PartRequest, []);
    if (kind === 'foreign-customer') {
      actor = { id: id(10), role: Role.CUSTOMER };
      f.rows.get(User)!.push({ ...f.customer, id: actor.id });
    }
    if (kind === 'foreign-technician') {
      actor = { id: id(10), role: Role.TECHNICIAN };
      f.rows.get(User)!.push({ ...f.technician, id: actor.id });
    }
    if (kind === 'inactive') f.customer.isActive = false;
    if (kind === 'stale-role') f.customer.role = Role.TECHNICIAN;
    if (kind === 'revoked-assignment') f.assignment.isActive = false;
    if (kind === 'changed-owner') f.booking.customerId = id(10);
    if (kind === 'admin') {
      f.customer.role = Role.ADMIN;
      actor.role = Role.ADMIN;
    }
    if (kind === 'manager') {
      f.customer.role = Role.SERVICE_MANAGER;
      actor.role = Role.SERVICE_MANAGER;
    }
    if (kind === 'extra-authority') actor.approved = true;
    const error = await f.service
      .preview(f.request.id, actor)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    if (!(error instanceof NotFoundException)) throw error;
    expect(error.getResponse()).toEqual({
      statusCode: 404,
      message: 'Không tìm thấy yêu cầu.',
      error: 'Not Found',
    });
    expect(f.manager.existsBy).not.toHaveBeenCalled();
  });

  it.each(['database unavailable', 'NOT_FOUND_OR_DENIED'])(
    'propagates infrastructure failure unchanged: %s',
    async (message) => {
      const f = fixture();
      const failure = new Error(message);
      f.manager.findOne.mockRejectedValueOnce(failure);
      await expect(
        f.service.preview(f.request.id, principal(f.customer)),
      ).rejects.toBe(failure);
    },
  );

  it('propagates invoice read errors unchanged', async () => {
    const f = fixture();
    const failure = new Error('NOT_FOUND_OR_DENIED');
    f.manager.existsBy.mockRejectedValueOnce(failure);
    await expect(
      f.service.preview(f.request.id, principal(f.customer)),
    ).rejects.toBe(failure);
  });
});
