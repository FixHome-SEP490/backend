import { describe, expect, it } from 'vitest';
import { PartRequestType, PartSource, Role, ServiceOrderStatus } from '../../shared/enums';
import {
  applyCustodyCommand,
  createPartCustodySnapshot,
  PartCustodyCommand,
  PartCustodyRuleError,
} from './part-custody.rules';
import { PartCustodyActor } from './part-custody.types';

const technician: PartCustodyActor = { id: 'former-technician', role: Role.TECHNICIAN };
const manager: PartCustodyActor = { id: 'manager-1', role: Role.SERVICE_MANAGER };
const now = '2026-10-19T00:00:00.000+07:00';

function snapshot(overrides: Record<string, unknown> = {}) {
  return createPartCustodySnapshot({
    serviceOrderId: 'order-1',
    partRequestId: 'request-1',
    partRequestItemId: 'item-1',
    requestType: PartRequestType.PRE_REPAIR,
    additionalCostId: null,
    partCatalogId: 'catalog-1',
    source: PartSource.FIXHOME,
    originalCustodianTechnicianId: 'former-technician',
    issuedQty: 3,
    usedQty: 0,
    serviceOrderStatus: ServiceOrderStatus.UNDER_REPAIR,
    invoiceFrozen: false,
    ...overrides,
  } as Parameters<typeof createPartCustodySnapshot>[0]);
}

function command(fields: Record<string, unknown>): PartCustodyCommand {
  return {
    partRequestId: 'request-1',
    partRequestItemId: 'item-1',
    ...fields,
  } as PartCustodyCommand;
}

describe('Part custody domain rules', () => {
  it('records an explicit initial zero usage decision with the normal audit and replay guarantees', () => {
    const zero = command({ kind: 'record_usage', usedQty: 0, expectedVersion: 0, idempotencyKey: 'zero-usage-01' });
    const result = applyCustodyCommand(snapshot(), zero, technician, now);
    expect(result.next).toMatchObject({ version: 1, usedQty: 0, outstandingQty: 3 });
    expect(result.events[0]).toMatchObject({ type: 'USAGE_RECORDED', usedQty: 0 });
    expect(applyCustodyCommand(result.next, zero, technician, now).replayed).toBe(true);
  });
  it('rejects extraneous command fields even outside HTTP validation', () => {
    expect(() => applyCustodyCommand(snapshot(), command({ kind: 'declare_return', quantity: 1, usedQty: 2,
      expectedVersion: 0, idempotencyKey: 'mixed-cmd-01' }), technician, now)).toThrowError(expect.objectContaining({ code: 'INVALID_COMMAND' }));
  });
  it('keeps a declared FixHome return outstanding until the manager physically accepts it', () => {
    const initial = snapshot();
    const usage = applyCustodyCommand(initial, command({
      kind: 'record_usage', usedQty: 2, expectedVersion: 0, idempotencyKey: 'usage-0001',
    }), technician, now);
    const declaration = applyCustodyCommand(usage.next, command({
      kind: 'declare_return', quantity: 1, expectedVersion: 1, idempotencyKey: 'return-0001',
    }), technician, now);

    expect(declaration.next).toMatchObject({
      issuedQty: 3,
      usedQty: 2,
      returnDueQty: 1,
      managerAcceptedQty: 0,
      unresolvedQty: 1,
      outstandingQty: 1,
    });
    expect(declaration.next.declarations).toHaveLength(1);
    expect(declaration.next.receipts).toHaveLength(0);

    const receipt = applyCustodyCommand(declaration.next, command({
      kind: 'accept_return', quantity: 1, expectedVersion: 2, idempotencyKey: 'receipt-0001',
    }), manager, now);

    expect(receipt.next).toMatchObject({
      issuedQty: 3,
      usedQty: 2,
      returnDueQty: 1,
      managerAcceptedQty: 1,
      unresolvedQty: 0,
      outstandingQty: 0,
    });
    expect(receipt.next.receipts).toHaveLength(1);
    expect(initial.usedQty).toBe(0);
    expect(initial.version).toBe(0);
  });

  it('allows partial physical receipts and closes only after cumulative acceptance reaches the due quantity', () => {
    const used = applyCustodyCommand(snapshot({ issuedQty: 5 }), command({
      kind: 'record_usage', usedQty: 2, expectedVersion: 0, idempotencyKey: 'usage-0002',
    }), technician, now);
    const declared = applyCustodyCommand(used.next, command({
      kind: 'declare_return', quantity: 3, expectedVersion: 1, idempotencyKey: 'return-0002',
    }), technician, now);
    const first = applyCustodyCommand(declared.next, command({
      kind: 'accept_return', quantity: 1, expectedVersion: 2, idempotencyKey: 'receipt-0002a',
    }), manager, now);

    expect(first.next.outstandingQty).toBe(2);
    expect(first.next.managerAcceptedQty).toBe(1);

    const second = applyCustodyCommand(first.next, command({
      kind: 'accept_return', quantity: 2, expectedVersion: 3, idempotencyKey: 'receipt-0002b',
    }), manager, now);

    expect(second.next.outstandingQty).toBe(0);
    expect(second.next.managerAcceptedQty).toBe(3);
    expect(second.next.receipts.map((receipt) => receipt.quantity)).toEqual([1, 2]);
  });

  it('replays an idempotent command and rejects reuse of its key with a different body', () => {
    const initial = snapshot();
    const request = command({
      kind: 'declare_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'return-same-key',
    });
    const first = applyCustodyCommand(initial, request, technician, now);
    const replay = applyCustodyCommand(first.next, request, technician, now);

    expect(replay.replayed).toBe(true);
    expect(replay.events).toEqual(first.events);
    expect(replay.next).toEqual(first.next);

    expect(() => applyCustodyCommand(first.next, command({
      kind: 'declare_return', quantity: 2, expectedVersion: 0, idempotencyKey: 'return-same-key',
    }), technician, now)).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  it('rejects stale versions and over-acceptance', () => {
    const declared = applyCustodyCommand(snapshot(), command({
      kind: 'declare_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'return-0003',
    }), technician, now);

    expect(() => applyCustodyCommand(declared.next, command({
      kind: 'accept_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'receipt-stale',
    }), manager, now)).toThrowError(expect.objectContaining({ code: 'STALE_VERSION' }));
    expect(() => applyCustodyCommand(declared.next, command({
      kind: 'accept_return', quantity: 2, expectedVersion: 1, idempotencyKey: 'receipt-over',
    }), manager, now)).toThrowError(expect.objectContaining({ code: 'OVER_ACCEPT' }));
  });

  it('uses the original custodian after reassignment and enforces exact actor roles', () => {
    const initial = snapshot({ originalCustodianTechnicianId: 'former-technician' });

    expect(() => applyCustodyCommand(initial, command({
      kind: 'declare_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'new-tech-0001',
    }), { id: 'new-technician', role: Role.TECHNICIAN }, now))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));

    expect(() => applyCustodyCommand(initial, command({
      kind: 'accept_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'admin-000001',
    }), { id: 'admin-1', role: Role.ADMIN }, now))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));

    expect(() => applyCustodyCommand(initial, command({
      kind: 'accept_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'tech-receipt-01',
    }), technician, now)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));

    expect(() => applyCustodyCommand(initial, command({
      kind: 'declare_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'other-line-0001',
      partRequestItemId: 'different-item',
    }), technician, now)).toThrowError(expect.objectContaining({ code: 'RESOURCE_MISMATCH' }));

    const declaration = applyCustodyCommand(initial, command({
      kind: 'declare_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'former-tech-01',
    }), technician, now);
    expect(declaration.next.declarations[0].actorUserId).toBe('former-technician');
  });

  it('does not create FixHome return obligations for technician-sourced parts', () => {
    const initial = snapshot({ source: PartSource.TECHNICIAN });

    expect(initial.outstandingQty).toBe(0);
    expect(() => applyCustodyCommand(initial, command({
      kind: 'declare_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'tech-source-001',
    }), technician, now)).toThrowError(expect.objectContaining({ code: 'SOURCE_NOT_RETURNABLE' }));
  });

  it('keeps reused PRE_REPAIR and multiple ADDITIONAL lines separate by request and approved cost', () => {
    const preRepair = snapshot({
      partRequestItemId: 'pre-repair-item', requestType: PartRequestType.PRE_REPAIR, additionalCostId: null,
    });
    const additionalOne = snapshot({
      partRequestId: 'additional-request-1', partRequestItemId: 'additional-item-1',
      requestType: PartRequestType.ADDITIONAL, additionalCostId: 'approved-cost-1',
    });
    const additionalTwo = snapshot({
      partRequestId: 'additional-request-2', partRequestItemId: 'additional-item-2',
      requestType: PartRequestType.ADDITIONAL, additionalCostId: 'approved-cost-2',
    });

    const returnForSecondApproval = applyCustodyCommand(additionalTwo, command({
      kind: 'declare_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'additional-two-return',
      partRequestId: additionalTwo.partRequestId, partRequestItemId: additionalTwo.partRequestItemId,
    }), technician, now);

    expect([preRepair.partRequestItemId, additionalOne.partRequestItemId, additionalTwo.partRequestItemId])
      .toEqual(['pre-repair-item', 'additional-item-1', 'additional-item-2']);
    expect(returnForSecondApproval.next.declarations).toHaveLength(1);
    expect(additionalOne.declarations).toHaveLength(0);
    expect(additionalTwo.declarations).toHaveLength(0);
    expect(returnForSecondApproval.next.additionalCostId).toBe('approved-cost-2');
  });

  it.each([ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED])(
    'allows custody declaration and receipt after order status %s without changing that status',
    (serviceOrderStatus) => {
      const initial = snapshot({ serviceOrderStatus, usedQty: 2, invoiceFrozen: false });
      expect(() => applyCustodyCommand(initial, command({
        kind: 'record_usage', usedQty: 3, expectedVersion: 0, idempotencyKey: `closed-usage-${serviceOrderStatus}`,
      }), technician, now)).toThrowError(expect.objectContaining({ code: 'ORDER_CLOSED' }));
      const declaration = applyCustodyCommand(initial, command({
        kind: 'declare_return', quantity: 1, expectedVersion: 0, idempotencyKey: `closed-${serviceOrderStatus}`,
      }), technician, now);
      const receipt = applyCustodyCommand(declaration.next, command({
        kind: 'accept_return', quantity: 1, expectedVersion: 1, idempotencyKey: `closed-receipt-${serviceOrderStatus}`,
      }), manager, now);

      expect(receipt.next.serviceOrderStatus).toBe(serviceOrderStatus);
      expect(receipt.next.outstandingQty).toBe(0);
    },
  );

  it('rejects usage changes after invoice freeze, lets an unfrozen count be corrected down, and does not support disposition commands', () => {
    const frozen = snapshot({ usedQty: 2, invoiceFrozen: true });
    expect(() => applyCustodyCommand(frozen, command({
      kind: 'record_usage', usedQty: 3, expectedVersion: 0, idempotencyKey: 'frozen-usage-01',
    }), technician, now)).toThrowError(expect.objectContaining({ code: 'INVOICE_FROZEN' }));

    const unfrozen = snapshot({ usedQty: 2 });
    expect(applyCustodyCommand(unfrozen, command({
      kind: 'record_usage', usedQty: 1, expectedVersion: 0, idempotencyKey: 'reverse-usage-01',
    }), technician, now).next.usedQty).toBe(1);
    expect(() => applyCustodyCommand(unfrozen, command({
      kind: 'approve_disposition', quantity: 1, expectedVersion: 0, idempotencyKey: 'disposition-001',
    }), manager, now)).toThrowError(PartCustodyRuleError);
    expect(unfrozen.explicitlyApprovedDispositionQty).toBe(0);

    expect(() => applyCustodyCommand(unfrozen, command({
      kind: 'reverse_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'reverse-return-01',
    }), manager, now)).toThrowError(PartCustodyRuleError);
  });

  it('records a zero-receipt mismatch as a discrepancy without a receipt', () => {
    const declared = applyCustodyCommand(snapshot({ usedQty: 2 }), command({
      kind: 'declare_return', quantity: 1, expectedVersion: 0, idempotencyKey: 'return-discrepancy',
    }), technician, now);
    const discrepancy = applyCustodyCommand(declared.next, command({
      kind: 'report_discrepancy', declaredQty: 1, observedQty: 0, expectedVersion: 1,
      idempotencyKey: 'discrepancy-0001', evidenceReferenceId: 'da8b3cc7-147d-48fd-a4ce-91699524a4c7', reason: 'not received',
    }), manager, now);

    expect(discrepancy.events[0].type).toBe('DISCREPANCY');
    expect(discrepancy.next.receipts).toHaveLength(0);
    expect(discrepancy.next.managerAcceptedQty).toBe(0);
    expect(discrepancy.next.outstandingQty).toBe(1);
    expect(discrepancy.events[0]).not.toHaveProperty('reason');
  });
});
