import { createHash } from 'crypto';
import { PartRequestType, PartSource, Role, ServiceOrderStatus } from '../../shared/enums';
import {
  PartCustodyActor,
  PartCustodyAuditEvent,
  PartCustodyCommand,
  PartCustodyCommandKind,
  PartCustodyCommandResult,
  PartCustodyIdempotencyRecord,
  PartCustodyOutcome,
  PartCustodyReceipt,
  PartCustodySnapshot,
  PartCustodySnapshotInput,
} from './part-custody.types';

export { PartCustodyCommand, PartCustodyCommandResult } from './part-custody.types';

export type PartCustodyRuleErrorCode =
  | 'INVALID_SNAPSHOT'
  | 'INVALID_COMMAND'
  | 'INVALID_QUANTITY'
  | 'FORBIDDEN'
  | 'RESOURCE_MISMATCH'
  | 'SOURCE_NOT_RETURNABLE'
  | 'OVER_ACCEPT'
  | 'STALE_VERSION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVOICE_FROZEN'
  | 'ORDER_CLOSED'
  | 'NO_CHANGE';

export class PartCustodyRuleError extends Error {
  constructor(readonly code: PartCustodyRuleErrorCode, message: string) {
    super(message);
    this.name = 'PartCustodyRuleError';
  }
}

export const MAX_PART_QUANTITY = 100;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(code: PartCustodyRuleErrorCode, message: string): never {
  throw new PartCustodyRuleError(code, message);
}

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isNonEmptyString(value: unknown, maxLength = 128): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableCopy(item))) as T;
  }
  if (value && typeof value === 'object') {
    const copy = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, immutableCopy(entry)]),
    );
    return Object.freeze(copy) as T;
  }
  return value;
}

function returnDueQty(source: PartSource, issuedQty: number, usedQty: number): number {
  return source === PartSource.FIXHOME ? issuedQty - usedQty : 0;
}

function unresolvedQty(issuedQty: number, usedQty: number, acceptedQty: number): number {
  return issuedQty - usedQty - acceptedQty;
}

function outstandingQty(source: PartSource, unresolved: number): number {
  return source === PartSource.FIXHOME ? unresolved : 0;
}

function createOutcome(snapshot: PartCustodySnapshot, kind: PartCustodyCommandKind): PartCustodyOutcome {
  return immutableCopy({
    kind,
    version: snapshot.version,
    usedQty: snapshot.usedQty,
    returnDueQty: snapshot.returnDueQty,
    managerAcceptedQty: snapshot.managerAcceptedQty,
    unresolvedQty: snapshot.unresolvedQty,
    outstandingQty: snapshot.outstandingQty,
  });
}

function validateSnapshot(snapshot: PartCustodySnapshot): void {
  if (!snapshot || typeof snapshot !== 'object') fail('INVALID_SNAPSHOT', 'A custody snapshot is required');
  if (
    !isNonEmptyString(snapshot.serviceOrderId) ||
    !isNonEmptyString(snapshot.partRequestId) ||
    !isNonEmptyString(snapshot.partRequestItemId) ||
    !isNonEmptyString(snapshot.originalCustodianTechnicianId)
  ) fail('INVALID_SNAPSHOT', 'Custody snapshot identifiers are invalid');
  if (!Object.values(PartRequestType).includes(snapshot.requestType)) {
    fail('INVALID_SNAPSHOT', 'Custody request type is invalid');
  }
  if (snapshot.requestType === PartRequestType.ADDITIONAL && !isNonEmptyString(snapshot.additionalCostId)) {
    fail('INVALID_SNAPSHOT', 'An additional part request must reference its approved cost');
  }
  if (snapshot.requestType === PartRequestType.QUOTATION && (!isNonEmptyString(snapshot.quotationId) || snapshot.additionalCostId != null)) {
    fail('INVALID_SNAPSHOT', 'A quotation part request must reference only its approved quotation');
  }
  if (![PartSource.FIXHOME, PartSource.TECHNICIAN, PartSource.EXTERNAL].includes(snapshot.source)) {
    fail('INVALID_SNAPSHOT', 'Custody part source is invalid');
  }
  if (!Object.values(ServiceOrderStatus).includes(snapshot.serviceOrderStatus)) {
    fail('INVALID_SNAPSHOT', 'Service order status is invalid');
  }
  if (!isIntegerBetween(snapshot.issuedQty, 1, MAX_PART_QUANTITY)) {
    fail('INVALID_SNAPSHOT', 'Issued quantity is invalid');
  }
  if (!isIntegerBetween(snapshot.usedQty, 0, snapshot.issuedQty)) {
    fail('INVALID_SNAPSHOT', 'Used quantity is invalid');
  }
  if (!isIntegerBetween(snapshot.version, 0, Number.MAX_SAFE_INTEGER)) {
    fail('INVALID_SNAPSHOT', 'Custody version is invalid');
  }
  if (typeof snapshot.invoiceFrozen !== 'boolean') fail('INVALID_SNAPSHOT', 'Invoice freeze state is invalid');
  if (!Array.isArray(snapshot.declarations) || !Array.isArray(snapshot.receipts) || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.idempotencyKeys)) {
    fail('INVALID_SNAPSHOT', 'Custody history is invalid');
  }
  if (snapshot.explicitlyApprovedDispositionQty !== 0) {
    fail('INVALID_SNAPSHOT', 'Unapproved disposition quantity must remain zero');
  }

  const acceptedFromReceipts = snapshot.receipts.reduce((sum, receipt) => {
    if (!isIntegerBetween(receipt.quantity, 1, MAX_PART_QUANTITY)) fail('INVALID_SNAPSHOT', 'Receipt quantity is invalid');
    return sum + receipt.quantity;
  }, 0);
  if (snapshot.managerAcceptedQty !== acceptedFromReceipts) {
    fail('INVALID_SNAPSHOT', 'Accepted quantity does not match physical receipt records');
  }
  const declaredTotal = snapshot.declarations.reduce((sum, declaration) => {
    if (!isIntegerBetween(declaration.quantity, 1, MAX_PART_QUANTITY)) fail('INVALID_SNAPSHOT', 'Declaration quantity is invalid');
    return sum + declaration.quantity;
  }, 0);
  if (snapshot.managerAcceptedQty > declaredTotal) {
    fail('INVALID_SNAPSHOT', 'Accepted quantity exceeds declared quantity');
  }

  const unresolved = unresolvedQty(snapshot.issuedQty, snapshot.usedQty, snapshot.managerAcceptedQty);
  if (unresolved < 0) fail('INVALID_SNAPSHOT', 'Custody quantities do not conserve issued parts');
  const due = returnDueQty(snapshot.source, snapshot.issuedQty, snapshot.usedQty);
  if (
    snapshot.returnDueQty !== due ||
    snapshot.unresolvedQty !== unresolved ||
    snapshot.outstandingQty !== outstandingQty(snapshot.source, unresolved)
  ) fail('INVALID_SNAPSHOT', 'Custody balances do not match the quantity ledger');
  if (snapshot.source === PartSource.FIXHOME && (snapshot.managerAcceptedQty > due || declaredTotal > due)) {
    fail('INVALID_SNAPSHOT', 'FixHome return history exceeds the outstanding quantity');
  }
  if (snapshot.source !== PartSource.FIXHOME && (snapshot.managerAcceptedQty !== 0 || declaredTotal !== 0)) {
    fail('INVALID_SNAPSHOT', 'Non-FixHome items cannot carry FixHome return records');
  }

  const keys = new Set<string>();
  for (const entry of snapshot.idempotencyKeys) {
    if (!entry || !isNonEmptyString(entry.key, 128) || keys.has(entry.key)) {
      fail('INVALID_SNAPSHOT', 'Custody idempotency history is invalid');
    }
    keys.add(entry.key);
  }
}

export function createPartCustodySnapshot(input: PartCustodySnapshotInput): PartCustodySnapshot {
  if (!input || typeof input !== 'object') fail('INVALID_SNAPSHOT', 'Custody snapshot input is required');
  if (!isIntegerBetween(input.issuedQty, 1, MAX_PART_QUANTITY)) fail('INVALID_SNAPSHOT', 'Issued quantity is invalid');
  if (!isIntegerBetween(input.usedQty, 0, input.issuedQty)) fail('INVALID_SNAPSHOT', 'Used quantity is invalid');
  if (!isNonEmptyString(input.serviceOrderId) || !isNonEmptyString(input.partRequestId) || !isNonEmptyString(input.partRequestItemId) || !isNonEmptyString(input.originalCustodianTechnicianId)) {
    fail('INVALID_SNAPSHOT', 'Custody snapshot identifiers are invalid');
  }
  if (input.requestType === PartRequestType.ADDITIONAL && !isNonEmptyString(input.additionalCostId)) {
    fail('INVALID_SNAPSHOT', 'An additional part request must reference its approved cost');
  }

  const acceptedQty = 0;
  const unresolved = unresolvedQty(input.issuedQty, input.usedQty, acceptedQty);
  const snapshot: PartCustodySnapshot = {
    ...input,
    returnDueQty: returnDueQty(input.source, input.issuedQty, input.usedQty),
    managerAcceptedQty: acceptedQty,
    unresolvedQty: unresolved,
    outstandingQty: outstandingQty(input.source, unresolved),
    explicitlyApprovedDispositionQty: 0,
    version: 0,
    declarations: [],
    receipts: [],
    events: [],
    idempotencyKeys: [],
  };
  validateSnapshot(snapshot);
  return immutableCopy(snapshot);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function requestFingerprint(command: PartCustodyCommand): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(command))).digest('hex');
}

function validateCommand(command: PartCustodyCommand): void {
  if (!command || typeof command !== 'object') fail('INVALID_COMMAND', 'A custody command is required');
  if (!['record_usage', 'declare_return', 'accept_return', 'report_discrepancy'].includes(command.kind)) {
    fail('INVALID_COMMAND', 'Custody command type is invalid');
  }
  const specific = command.kind === 'record_usage' ? ['usedQty']
    : command.kind === 'report_discrepancy' ? ['declaredQty', 'observedQty'] : ['quantity'];
  const allowed = ['partRequestId', 'partRequestItemId', 'kind', 'expectedVersion', 'idempotencyKey', 'reason', 'evidenceReferenceId', ...specific];
  if (Object.entries(command).some(([key, value]) => value !== undefined && !allowed.includes(key))) {
    fail('INVALID_COMMAND', 'Unexpected fields for custody command');
  }
  if (!isNonEmptyString(command.partRequestId) || !isNonEmptyString(command.partRequestItemId)) {
    fail('INVALID_COMMAND', 'Custody request identifiers are invalid');
  }
  if (!isIntegerBetween(command.expectedVersion, 0, Number.MAX_SAFE_INTEGER)) {
    fail('INVALID_COMMAND', 'Expected custody version is invalid');
  }
  if (typeof command.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(command.idempotencyKey)) {
    fail('INVALID_COMMAND', 'Custody idempotency key is invalid');
  }
  if (command.evidenceReferenceId !== undefined && !UUID_PATTERN.test(command.evidenceReferenceId)) {
    fail('INVALID_COMMAND', 'Evidence reference is invalid');
  }
  if (command.reason !== undefined && typeof command.reason !== 'string') {
    fail('INVALID_COMMAND', 'Custody reason is invalid');
  }

  switch (command.kind) {
    case 'record_usage':
      if (!isIntegerBetween(command.usedQty, 0, MAX_PART_QUANTITY)) fail('INVALID_QUANTITY', 'Used quantity is invalid');
      return;
    case 'declare_return':
    case 'accept_return':
      if (!isIntegerBetween(command.quantity, 1, MAX_PART_QUANTITY)) fail('INVALID_QUANTITY', 'Return quantity is invalid');
      return;
    case 'report_discrepancy':
      if (!isIntegerBetween(command.declaredQty, 1, MAX_PART_QUANTITY) || !isIntegerBetween(command.observedQty, 0, MAX_PART_QUANTITY)) {
        fail('INVALID_QUANTITY', 'Discrepancy quantity is invalid');
      }
      return;
  }
}

function assertAuthorized(snapshot: PartCustodySnapshot, command: PartCustodyCommand, actor: PartCustodyActor): void {
  if (!actor || !isNonEmptyString(actor.id)) fail('FORBIDDEN', 'A valid custody actor is required');
  if (command.partRequestId !== snapshot.partRequestId || command.partRequestItemId !== snapshot.partRequestItemId) {
    fail('RESOURCE_MISMATCH', 'Custody command does not match the requested part line');
  }

  if (command.kind === 'record_usage' || command.kind === 'declare_return') {
    if (actor.role !== Role.TECHNICIAN || actor.id !== snapshot.originalCustodianTechnicianId) {
      fail('FORBIDDEN', 'Only the original technician custodian can declare or update part usage');
    }
    return;
  }
  if (actor.role !== Role.SERVICE_MANAGER) {
    fail('FORBIDDEN', 'Service Manager role required for physical receipt decisions');
  }
}

function findPriorResult(snapshot: PartCustodySnapshot, command: PartCustodyCommand, actor: PartCustodyActor): PartCustodyCommandResult | null {
  const prior = snapshot.idempotencyKeys.find((entry) => entry.key === command.idempotencyKey);
  if (!prior) return null;
  if (
    prior.requestFingerprint !== requestFingerprint(command) ||
    prior.actorUserId !== actor.id ||
    prior.actorRole !== actor.role
  ) fail('IDEMPOTENCY_CONFLICT', 'Custody idempotency key was reused with a different request');

  return immutableCopy({
    next: snapshot,
    events: prior.events,
    replayed: true,
    outcome: prior.outcome,
  });
}

function toTimestamp(now: Date | string): string {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(date.getTime())) fail('INVALID_COMMAND', 'Custody timestamp is invalid');
  return date.toISOString();
}

function sumDeclared(declarations: PartCustodySnapshot['declarations']): number {
  return declarations.reduce((sum, declaration) => sum + declaration.quantity, 0);
}

function makeEvent(
  snapshot: PartCustodySnapshot,
  command: PartCustodyCommand,
  actor: PartCustodyActor,
  now: string,
  version: number,
): PartCustodyAuditEvent {
  const shared = {
    id: `${snapshot.partRequestItemId}:v${version}`,
    partRequestId: snapshot.partRequestId,
    partRequestItemId: snapshot.partRequestItemId,
    actorUserId: actor.id,
    actorRole: actor.role,
    occurredAt: now,
    version,
    idempotencyKey: command.idempotencyKey,
  };
  switch (command.kind) {
    case 'record_usage':
      return immutableCopy({ ...shared, type: 'USAGE_RECORDED', usedQty: command.usedQty });
    case 'declare_return':
      return immutableCopy({
        ...shared,
        type: 'RETURN_DECLARED',
        quantity: command.quantity,
        reasonProvided: Boolean(command.reason?.trim()),
        ...(command.evidenceReferenceId ? { evidenceReferenceId: command.evidenceReferenceId } : {}),
      });
    case 'accept_return':
      return immutableCopy({
        ...shared,
        type: 'RETURN_ACCEPTED',
        quantity: command.quantity,
        ...(command.evidenceReferenceId ? { evidenceReferenceId: command.evidenceReferenceId } : {}),
      });
    case 'report_discrepancy':
      return immutableCopy({
        ...shared,
        type: 'DISCREPANCY',
        declaredQty: command.declaredQty,
        observedQty: command.observedQty,
        reasonProvided: Boolean(command.reason?.trim()),
        ...(command.evidenceReferenceId ? { evidenceReferenceId: command.evidenceReferenceId } : {}),
      });
  }
}

export function applyCustodyCommand(
  snapshot: PartCustodySnapshot,
  command: PartCustodyCommand,
  actor: PartCustodyActor,
  now: Date | string,
): PartCustodyCommandResult {
  validateSnapshot(snapshot);
  validateCommand(command);
  assertAuthorized(snapshot, command, actor);

  const prior = findPriorResult(snapshot, command, actor);
  if (prior) return prior;
  if (command.expectedVersion !== snapshot.version) fail('STALE_VERSION', 'Custody snapshot version is stale');

  const returnAction = command.kind !== 'record_usage';
  if (returnAction && snapshot.source !== PartSource.FIXHOME) {
    fail('SOURCE_NOT_RETURNABLE', 'Only FixHome-sourced parts have a FixHome return obligation');
  }

  let usedQty = snapshot.usedQty;
  let managerAcceptedQty = snapshot.managerAcceptedQty;
  let declarations = [...snapshot.declarations];
  let receipts: PartCustodyReceipt[] = [...snapshot.receipts];
  if (command.kind === 'record_usage') {
    if ([ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED].includes(snapshot.serviceOrderStatus)) {
      fail('ORDER_CLOSED', 'Used quantity cannot change after order closure');
    }
    if (snapshot.invoiceFrozen) fail('INVOICE_FROZEN', 'Used quantity is frozen with the invoice');
    if (command.usedQty < snapshot.usedQty || command.usedQty > snapshot.issuedQty - managerAcceptedQty) {
      fail('INVALID_QUANTITY', 'Used quantity cannot reverse or exceed unresolved custody');
    }
    const initialZeroDecision = command.usedQty === 0 && snapshot.usedQty === 0 && !snapshot.events.some(e => e.type === 'USAGE_RECORDED');
    if (command.usedQty === snapshot.usedQty && !initialZeroDecision) fail('NO_CHANGE', 'Used quantity is unchanged');
    if (sumDeclared(declarations) > snapshot.issuedQty - command.usedQty) {
      fail('INVALID_QUANTITY', 'Used quantity would exceed the remaining declared return quantity');
    }
    usedQty = command.usedQty;
  } else if (command.kind === 'declare_return') {
    if (sumDeclared(declarations) + command.quantity > snapshot.returnDueQty) {
      fail('OVER_ACCEPT', 'Declared quantity exceeds the FixHome return due quantity');
    }
  } else if (command.kind === 'accept_return') {
    const pendingDeclarationQty = sumDeclared(declarations) - managerAcceptedQty;
    if (command.quantity > snapshot.outstandingQty || command.quantity > pendingDeclarationQty) {
      fail('OVER_ACCEPT', 'Accepted quantity exceeds declared outstanding quantity');
    }
    managerAcceptedQty += command.quantity;
    receipts = [
      ...receipts,
      immutableCopy({
        quantity: command.quantity,
        actorUserId: actor.id,
        actorRole: actor.role,
        acceptedAt: toTimestamp(now),
        idempotencyKey: command.idempotencyKey,
        ...(command.evidenceReferenceId ? { evidenceReferenceId: command.evidenceReferenceId } : {}),
      }),
    ];
  } else {
    const pendingDeclarationQty = sumDeclared(declarations) - managerAcceptedQty;
    if (command.declaredQty > pendingDeclarationQty || command.observedQty >= command.declaredQty) {
      fail('INVALID_COMMAND', 'A discrepancy must identify a mismatched declared quantity');
    }
  }

  const nextVersion = snapshot.version + 1;
  const occurredAt = toTimestamp(now);
  const event = makeEvent(snapshot, command, actor, occurredAt, nextVersion);
  if (command.kind === 'declare_return') {
    declarations = [
      ...declarations,
      immutableCopy({
        quantity: command.quantity,
        actorUserId: actor.id,
        actorRole: actor.role,
        declaredAt: occurredAt,
        idempotencyKey: command.idempotencyKey,
        ...(command.evidenceReferenceId ? { evidenceReferenceId: command.evidenceReferenceId } : {}),
      }),
    ];
  }

  const unresolved = unresolvedQty(snapshot.issuedQty, usedQty, managerAcceptedQty);
  const nextDraft: PartCustodySnapshot = {
    ...snapshot,
    usedQty,
    returnDueQty: returnDueQty(snapshot.source, snapshot.issuedQty, usedQty),
    managerAcceptedQty,
    unresolvedQty: unresolved,
    outstandingQty: outstandingQty(snapshot.source, unresolved),
    version: nextVersion,
    declarations,
    receipts,
    events: [...snapshot.events, event],
    idempotencyKeys: snapshot.idempotencyKeys,
  };
  const outcome = createOutcome(nextDraft, command.kind);
  const idempotencyRecord: PartCustodyIdempotencyRecord = immutableCopy({
    key: command.idempotencyKey,
    requestFingerprint: requestFingerprint(command),
    actorUserId: actor.id,
    actorRole: actor.role,
    events: [event],
    outcome,
  });
  const next = immutableCopy({
    ...nextDraft,
    idempotencyKeys: [...snapshot.idempotencyKeys, idempotencyRecord],
  });
  validateSnapshot(next);

  return immutableCopy({ next, events: [event], replayed: false, outcome });
}
