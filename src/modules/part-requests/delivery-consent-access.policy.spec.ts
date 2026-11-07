import { describe, expect, it } from 'vitest';
import { AccountStatus, Role } from '../../shared/enums';
import {
  assertDeliveryPreviewOwner,
  assertDeliveryPreviewRole,
  deliveryPreviewPrincipal,
} from './delivery-consent-access.policy';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { id: id(1), role: Role.CUSTOMER };
const user = { ...principal, isActive: true, status: AccountStatus.ACTIVE };
const facts = () => ({
  request: { id: id(2), serviceOrderId: id(3), technicianId: id(4) },
  order: { id: id(3), bookingId: id(5) },
  booking: { id: id(5), customerId: id(1) },
  assignment: {
    id: id(6),
    serviceOrderId: id(3),
    technicianId: id(4),
    isActive: true,
  },
  technician: {
    id: id(4),
    role: Role.TECHNICIAN,
    isActive: true,
    status: AccountStatus.ACTIVE,
  },
});

describe('delivery preview access only (not JWT authentication or consent authority)', () => {
  it.each([
    null,
    {},
    { id: id(1) },
    { role: Role.CUSTOMER },
    { id: 'not-uuid', role: Role.CUSTOMER },
    { id: id(1), role: 'owner' },
    { ...principal, warehouseApproved: true },
  ])('redacts malformed principal %#', (input) => {
    expect(() => deliveryPreviewPrincipal(input)).toThrow(
      /^NOT_FOUND_OR_DENIED$/,
    );
  });
  it('normalizes a structurally valid identity but does not authenticate it', () => {
    expect(
      deliveryPreviewPrincipal({
        id: 'ABCDEFAB-0000-4000-8000-000000000001',
        role: Role.CUSTOMER,
      }),
    ).toEqual({
      id: 'abcdefab-0000-4000-8000-000000000001',
      role: Role.CUSTOMER,
    });
  });
  it('redacts missing/malformed ownership facts as the same denial', () => {
    for (const value of [undefined, null, {}])
      expect(() => assertDeliveryPreviewOwner(principal, value as any)).toThrow(
        /^NOT_FOUND_OR_DENIED$/,
      );
  });
  it.each(['id', 'role', 'inactive', 'suspended', 'missing'])(
    'denies stale/spoofed current actor %s uniformly',
    (issue) => {
      const current = { ...user };
      if (issue === 'id') current.id = id(99);
      if (issue === 'role') current.role = Role.ADMIN;
      if (issue === 'inactive') current.isActive = false;
      if (issue === 'suspended') current.status = AccountStatus.SUSPENDED;
      expect(() =>
        assertDeliveryPreviewRole(
          principal,
          issue === 'missing' ? null : current,
        ),
      ).toThrow(/^NOT_FOUND_OR_DENIED$/);
    },
  );
  it.each([Role.ADMIN, Role.SERVICE_MANAGER])(
    'grants no preview/consent/proposal authority for %s',
    (role) => {
      expect(() =>
        assertDeliveryPreviewRole({ ...principal, role }, { ...user, role }),
      ).toThrow(/^NOT_FOUND_OR_DENIED$/);
    },
  );
  it('accepts only the current Booking customer or matching active request technician for owner preview', () => {
    expect(() => assertDeliveryPreviewRole(principal, user)).not.toThrow();
    expect(() => assertDeliveryPreviewOwner(principal, facts())).not.toThrow();
    expect(() =>
      assertDeliveryPreviewOwner({ id: id(4), role: Role.TECHNICIAN }, facts()),
    ).not.toThrow();
    expect(() =>
      assertDeliveryPreviewOwner({ id: id(99), role: Role.CUSTOMER }, facts()),
    ).toThrow(/^NOT_FOUND_OR_DENIED$/);
    expect(() =>
      assertDeliveryPreviewOwner(
        { id: id(99), role: Role.TECHNICIAN },
        facts(),
      ),
    ).toThrow(/^NOT_FOUND_OR_DENIED$/);
  });
  it.each([
    'request_order',
    'order_booking',
    'assignment_order',
    'assignment_tech',
    'assignment_revoked',
    'technician_id',
    'technician_role',
    'technician_inactive',
  ])('does not compose unrelated identity facts: %s', (issue) => {
    const f = facts();
    if (issue === 'request_order') f.request.serviceOrderId = id(99);
    if (issue === 'order_booking') f.order.bookingId = id(99);
    if (issue === 'assignment_order') f.assignment.serviceOrderId = id(99);
    if (issue === 'assignment_tech') f.assignment.technicianId = id(99);
    if (issue === 'assignment_revoked') f.assignment.isActive = false;
    if (issue === 'technician_id') f.technician.id = id(99);
    if (issue === 'technician_role') f.technician.role = Role.CUSTOMER;
    if (issue === 'technician_inactive') f.technician.isActive = false;
    expect(() => assertDeliveryPreviewOwner(principal, f)).toThrow(
      /^NOT_FOUND_OR_DENIED$/,
    );
  });
});
