import { AccountStatus, Role } from '../../shared/enums';

export interface DeliveryPreviewPrincipal {
  readonly id: string;
  readonly role: Role;
}
export interface DeliveryPreviewUser extends DeliveryPreviewPrincipal {
  readonly isActive: boolean;
  readonly status: string;
}
export interface DeliveryPreviewOwnership {
  readonly request: {
    readonly id: string;
    readonly serviceOrderId: string;
    readonly technicianId: string;
  };
  readonly order: { readonly id: string; readonly bookingId: string };
  readonly booking: { readonly id: string; readonly customerId: string };
  readonly assignment: {
    readonly id: string;
    readonly serviceOrderId: string;
    readonly technicianId: string;
    readonly isActive: boolean;
  } | null;
  readonly technician: DeliveryPreviewUser | null;
}

/** Redacts resource existence/ownership failures. Infrastructure errors are NOT access verdicts. */
export function denyDeliveryPreview(): never {
  throw new Error('NOT_FOUND_OR_DENIED');
}

export function deliveryPreviewId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    return denyDeliveryPreview();
  return value.toLowerCase();
}

/** Structural parsing ONLY. A future trusted JWT guard must supply this identity, never a body.
 * These helpers authorize owner PREVIEW, never consent/proposal, and cannot authenticate JWTs. */
export function deliveryPreviewPrincipal(
  input: unknown,
): DeliveryPreviewPrincipal {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getOwnPropertySymbols(input).length ||
    Object.keys(input).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(input, 'id') ||
    !Object.prototype.hasOwnProperty.call(input, 'role')
  )
    return denyDeliveryPreview();
  const { id, role } = input as Record<string, unknown>;
  if (!Object.values(Role).includes(role as Role)) return denyDeliveryPreview();
  return Object.freeze({ id: deliveryPreviewId(id), role: role as Role });
}

/** Reloaded DB role/status must match the guard's principal. SM/Admin have no owner preview
 * or consent grant here; B1 NULL warehouse means no SM proposal authority can be proved. */
export function assertDeliveryPreviewRole(
  principal: DeliveryPreviewPrincipal,
  user: DeliveryPreviewUser | null,
): asserts user is DeliveryPreviewUser {
  if (
    !principal ||
    !user ||
    user.id !== principal.id ||
    user.role !== principal.role ||
    user.isActive !== true ||
    user.status !== AccountStatus.ACTIVE ||
    ![Role.CUSTOMER, Role.TECHNICIAN].includes(user.role)
  )
    denyDeliveryPreview();
}

/** Only server-read, current scope facts; caller must run assertDeliveryPreviewRole first.
 * This non-atomic comparison is NOT a transactional authority for a future mutation. */
export function assertDeliveryPreviewOwner(
  principal: DeliveryPreviewPrincipal,
  facts: DeliveryPreviewOwnership,
): void {
  if (!principal || !facts) return denyDeliveryPreview();
  const { request, order, booking, assignment, technician } = facts;
  if (
    !request ||
    !order ||
    !booking ||
    !assignment ||
    !technician ||
    request.serviceOrderId !== order.id ||
    order.bookingId !== booking.id ||
    assignment.serviceOrderId !== order.id ||
    assignment.technicianId !== request.technicianId ||
    assignment.isActive !== true ||
    technician.id !== request.technicianId ||
    technician.role !== Role.TECHNICIAN ||
    technician.isActive !== true ||
    technician.status !== AccountStatus.ACTIVE ||
    !(
      (principal.role === Role.CUSTOMER &&
        principal.id === booking.customerId) ||
      (principal.role === Role.TECHNICIAN &&
        principal.id === request.technicianId)
    )
  )
    denyDeliveryPreview();
}
