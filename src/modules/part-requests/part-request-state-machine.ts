// src/modules/part-requests/part-request-state-machine.ts
import { PartRequestStatus, FulfillmentMethod, Role } from '../../shared/enums';

/**
 * Part Request State Machine
 *
 * Lifecycle:
 *   REQUESTED → READY → RECEIVED → COMPLETED
 *   REQUESTED → READY → DELIVERING → RECEIVED → COMPLETED  (delivery)
 *   Any unreceived → CANCELLED
 *
 * Terminal states: COMPLETED, CANCELLED
 */
export class PartRequestStateMachine {
  private static readonly TRANSITIONS: Record<PartRequestStatus, PartRequestStatus[]> = {
    [PartRequestStatus.REQUESTED]: [
      PartRequestStatus.READY,
      PartRequestStatus.CANCELLED,
    ],
    [PartRequestStatus.READY]: [
      PartRequestStatus.RECEIVED,
      PartRequestStatus.DELIVERING,
      PartRequestStatus.CANCELLED,
    ],
    [PartRequestStatus.DELIVERING]: [
      PartRequestStatus.RECEIVED,
      PartRequestStatus.CANCELLED,
    ],
    [PartRequestStatus.RECEIVED]: [
      PartRequestStatus.COMPLETED,
    ],
    [PartRequestStatus.COMPLETED]: [],
    [PartRequestStatus.CANCELLED]: [],
  };

  /**
   * Role-based permissions:
   * - SERVICE_MANAGER: REQUESTED→READY, READY→DELIVERING
   * - TECHNICIAN: READY→RECEIVED (pickup), DELIVERING→RECEIVED (delivery scan)
   * - SERVICE_MANAGER: unreceived→CANCELLED
   * - System: RECEIVED→COMPLETED (auto on order complete)
   */
  private static readonly ROLE_TRANSITIONS: Partial<
    Record<Role, Partial<Record<PartRequestStatus, PartRequestStatus[]>>>
  > = {
    [Role.SERVICE_MANAGER]: {
      [PartRequestStatus.REQUESTED]: [PartRequestStatus.READY, PartRequestStatus.CANCELLED],
      [PartRequestStatus.READY]: [PartRequestStatus.DELIVERING, PartRequestStatus.CANCELLED],
      [PartRequestStatus.DELIVERING]: [PartRequestStatus.CANCELLED],
    },
    [Role.TECHNICIAN]: {
      [PartRequestStatus.REQUESTED]: [PartRequestStatus.CANCELLED],
      [PartRequestStatus.READY]: [PartRequestStatus.RECEIVED],
      [PartRequestStatus.DELIVERING]: [PartRequestStatus.RECEIVED],
    },
  };

  static canTransition(
    current: PartRequestStatus,
    next: PartRequestStatus,
    role?: Role,
  ): boolean {
    if (!current || !next || current === next) return false;
    const allowed = this.TRANSITIONS[current] || [];
    if (!allowed.includes(next)) return false;
    if (role) {
      const roleAllowed = this.ROLE_TRANSITIONS[role]?.[current] || [];
      return roleAllowed.includes(next);
    }
    return true;
  }

  /**
   * Validate fulfillment-aware transitions:
   * - PICKUP: READY → RECEIVED (technician scans QR at depot)
   * - DELIVERY: READY → DELIVERING → RECEIVED (SM dispatches, technician scans)
   */
  static canTransitionWithFulfillment(
    current: PartRequestStatus,
    next: PartRequestStatus,
    fulfillment: FulfillmentMethod,
    role?: Role,
  ): boolean {
    // Block READY→DELIVERING for PICKUP
    if (fulfillment === FulfillmentMethod.PICKUP && next === PartRequestStatus.DELIVERING) {
      return false;
    }
    if (next === PartRequestStatus.RECEIVED &&
      current !== (fulfillment === FulfillmentMethod.PICKUP ? PartRequestStatus.READY : PartRequestStatus.DELIVERING)) return false;
    return this.canTransition(current, next, role);
  }

  static getAllowedNextStates(
    current: PartRequestStatus,
    role?: Role,
  ): PartRequestStatus[] {
    if (!current) return [];
    if (role) return this.ROLE_TRANSITIONS[role]?.[current] || [];
    return this.TRANSITIONS[current] || [];
  }
}
