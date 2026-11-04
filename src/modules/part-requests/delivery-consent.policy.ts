import { createHash } from 'node:crypto';
import { Role } from '../../shared/enums';
import { calculateShippingShares } from '../finance/shipping-finance.policy';

/** Phase A values only. Scope, budgets and evidence references MUST come from future server reads.
 * Hashes identify content, not signed/persisted proof. No dispatch or financial authority exists here. */
export interface DeliveryScope {
  readonly partRequestId: string;
  readonly serviceOrderId: string;
  readonly customerId: string;
  readonly technicianId: string;
  readonly responsibleServiceManagerId: string;
}

export interface DeliveryActor {
  readonly id: string;
  readonly role: Role;
}
export interface DeliveryLaborBudget {
  readonly laborTotal: number;
  readonly commissionAmount: number;
  readonly knownApprovedDeductions: number;
}
interface CommandIdentity {
  readonly commandId: string;
  readonly expectedVersion: number;
}
export interface DeliveryProposalCommand extends CommandIdentity {
  readonly kind: 'PROPOSE' | 'REVISE';
  readonly totalShippingFee: number;
  readonly budget: DeliveryLaborBudget;
  readonly evidenceRef: string;
  readonly approvedCostRef: string;
}
export interface DeliveryConsentCommand extends CommandIdentity {
  readonly kind: 'CONSENT';
  readonly quoteVersion: number;
  readonly quoteFingerprint: string;
  readonly totalShippingFee: number;
  readonly shippingShare: number;
  readonly accepted: true;
  readonly evidenceRef: string;
}
export interface DeliveryActualCommand extends CommandIdentity {
  readonly kind: 'RECORD_ACTUAL';
  readonly quoteVersion: number;
  readonly totalShippingFee: number;
  readonly evidenceRef: string;
}
export type DeliveryCommand =
  DeliveryProposalCommand | DeliveryConsentCommand | DeliveryActualCommand;
export interface DeliveryCommandReceipt {
  readonly commandId: string;
  readonly contentFingerprint: string;
  readonly actor: DeliveryActor;
  readonly command: DeliveryCommand;
  readonly resultVersion: number;
}
export interface DeliveryQuote {
  readonly quoteVersion: number;
  readonly policyVersion: 'W3_70_30_V1';
  readonly totalShippingFee: number;
  readonly customerShippingShare: number;
  readonly technicianShippingShare: number;
  readonly netLaborAfterShipping: number;
  readonly budget: DeliveryLaborBudget;
  readonly evidenceRef: string;
  readonly approvedCostRef: string;
  readonly fingerprint: string;
}
export interface DeliveryConsent extends DeliveryConsentCommand {
  readonly actor: DeliveryActor;
  readonly contentFingerprint: string;
}
export interface DeliveryActual extends DeliveryActualCommand {
  readonly actor: DeliveryActor;
  readonly contentFingerprint: string;
  readonly approvedCeilingTotal: number;
  readonly customerShippingShare: number;
  readonly technicianShippingShare: number;
}
export interface DeliveryConsentState {
  /** CAS revision increases on EVERY accepted command; consent binds the separate quoteVersion. */
  readonly version: number;
  readonly scope: DeliveryScope;
  readonly quote: DeliveryQuote;
  readonly customerConsent: DeliveryConsent | null;
  readonly technicianConsent: DeliveryConsent | null;
  readonly actual: DeliveryActual | null;
  readonly status: 'AWAITING_DUAL_CONSENT' | 'CONSENTED' | 'ACTUAL_RECORDED';
  readonly payoutBlockReason:
    'FINANCIAL_CUTOVER_CLOSED' | 'KNOWN_DEDUCTIONS_LEDGER_REQUIRED';
  readonly receipts: readonly DeliveryCommandReceipt[];
}

const fail = (code: string): never => {
  throw new Error(`DELIVERY_${code}`);
};
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Copy caller-owned objects; structurally share only values already recursively frozen. */
function immutable<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value).map(
    ([k, v]) => [k, immutable(v)] as const,
  );
  if (Object.isFrozen(value) && entries.every(([k, v]) => value[k] === v))
    return value;
  return Object.freeze(
    Array.isArray(value)
      ? entries.map(([, v]) => v)
      : Object.fromEntries(entries),
  ) as T;
}

function exact(value: object, keys: readonly string[]): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    fail('INVALID_SHAPE');
}
function reference(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:_/-]{0,255}$/.test(value)
  )
    fail('EVIDENCE_OR_ID_REQUIRED');
  return value;
}
function integer(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) fail('INVALID_INTEGER');
  return value;
}
function next(value: number): number {
  return integer(value + 1, 1);
}
function normalizeScope(value: DeliveryScope): DeliveryScope {
  exact(value, [
    'partRequestId',
    'serviceOrderId',
    'customerId',
    'technicianId',
    'responsibleServiceManagerId',
  ]);
  const scope = {
    partRequestId: reference(value.partRequestId),
    serviceOrderId: reference(value.serviceOrderId),
    customerId: reference(value.customerId),
    technicianId: reference(value.technicianId),
    responsibleServiceManagerId: reference(value.responsibleServiceManagerId),
  };
  if (
    new Set([
      scope.customerId,
      scope.technicianId,
      scope.responsibleServiceManagerId,
    ]).size !== 3
  )
    fail('ACTOR_IDENTITIES_CONFLICT');
  return scope;
}
function normalizeActor(value: DeliveryActor): DeliveryActor {
  exact(value, ['id', 'role']);
  if (!Object.values(Role).includes(value.role)) fail('ACTOR_DENIED');
  return { id: reference(value.id), role: value.role };
}
function normalizeBudget(value: DeliveryLaborBudget): DeliveryLaborBudget {
  exact(value, ['laborTotal', 'commissionAmount', 'knownApprovedDeductions']);
  return {
    laborTotal: integer(value.laborTotal),
    commissionAmount: integer(value.commissionAmount),
    knownApprovedDeductions: integer(value.knownApprovedDeductions),
  };
}
function normalizeCommand(value: DeliveryCommand): DeliveryCommand {
  if (!value || typeof value !== 'object') fail('INVALID_COMMAND');
  const common = ['kind', 'commandId', 'expectedVersion'];
  if (
    typeof value.commandId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.commandId,
    )
  )
    fail('INVALID_COMMAND_ID');
  const identity = {
    commandId: value.commandId,
    expectedVersion: integer(value.expectedVersion),
  };
  switch (value.kind) {
    case 'PROPOSE':
    case 'REVISE':
      exact(value, [
        ...common,
        'totalShippingFee',
        'budget',
        'evidenceRef',
        'approvedCostRef',
      ]);
      return {
        kind: value.kind,
        ...identity,
        totalShippingFee: integer(value.totalShippingFee),
        budget: normalizeBudget(value.budget),
        evidenceRef: reference(value.evidenceRef),
        approvedCostRef: reference(value.approvedCostRef),
      };
    case 'CONSENT':
      exact(value, [
        ...common,
        'quoteVersion',
        'quoteFingerprint',
        'totalShippingFee',
        'shippingShare',
        'accepted',
        'evidenceRef',
      ]);
      if (
        value.accepted !== true ||
        typeof value.quoteFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.quoteFingerprint)
      )
        fail('EXPLICIT_BOUND_CONSENT_REQUIRED');
      return {
        kind: value.kind,
        ...identity,
        quoteVersion: integer(value.quoteVersion, 1),
        quoteFingerprint: value.quoteFingerprint,
        totalShippingFee: integer(value.totalShippingFee),
        shippingShare: integer(value.shippingShare),
        accepted: true,
        evidenceRef: reference(value.evidenceRef),
      };
    case 'RECORD_ACTUAL':
      exact(value, [
        ...common,
        'quoteVersion',
        'totalShippingFee',
        'evidenceRef',
      ]);
      return {
        kind: value.kind,
        ...identity,
        quoteVersion: integer(value.quoteVersion, 1),
        totalShippingFee: integer(value.totalShippingFee),
        evidenceRef: reference(value.evidenceRef),
      };
    default:
      return fail('INVALID_COMMAND');
  }
}
function authorize(
  scope: DeliveryScope,
  command: DeliveryCommand,
  actor: DeliveryActor,
): void {
  const allowed =
    command.kind === 'CONSENT'
      ? (actor.role === Role.CUSTOMER && actor.id === scope.customerId) ||
        (actor.role === Role.TECHNICIAN && actor.id === scope.technicianId)
      : actor.role === Role.SERVICE_MANAGER &&
        actor.id === scope.responsibleServiceManagerId;
  if (!allowed) fail('ACTOR_DENIED');
}
function commandFingerprint(
  scope: DeliveryScope,
  command: DeliveryCommand,
  actor: DeliveryActor,
): string {
  return digest([
    'W3_DELIVERY_CONSENT_V1',
    normalizeScope(scope),
    command,
    actor,
  ]);
}
function quoteFor(
  scope: DeliveryScope,
  command: DeliveryProposalCommand,
  quoteVersion: number,
): DeliveryQuote {
  const shares = calculateShippingShares(
    command.totalShippingFee,
    'W3_70_30_V1',
  );
  const b = command.budget;
  const net =
    BigInt(b.laborTotal) -
    BigInt(b.commissionAmount) -
    BigInt(b.knownApprovedDeductions) -
    BigInt(shares.technicianShippingShare);
  if (net < 0n) fail('INSUFFICIENT_NET_LABOR');
  const quote = {
    quoteVersion: integer(quoteVersion, 1),
    policyVersion: 'W3_70_30_V1' as const,
    totalShippingFee: command.totalShippingFee,
    ...shares,
    netLaborAfterShipping: Number(net),
    budget: normalizeBudget(b),
    evidenceRef: reference(command.evidenceRef),
    approvedCostRef: reference(command.approvedCostRef),
  };
  return { ...quote, fingerprint: digest([normalizeScope(scope), quote]) };
}
function finish(
  state: Omit<DeliveryConsentState, 'status' | 'payoutBlockReason'>,
): DeliveryConsentState {
  return immutable({
    ...state,
    status: state.actual
      ? 'ACTUAL_RECORDED'
      : state.customerConsent && state.technicianConsent
        ? 'CONSENTED'
        : 'AWAITING_DUAL_CONSENT',
    payoutBlockReason:
      state.quote.budget.knownApprovedDeductions > 0
        ? 'KNOWN_DEDUCTIONS_LEDGER_REQUIRED'
        : 'FINANCIAL_CUTOVER_CLOSED',
  });
}

/** Validate by replaying normalized receipts, never trusting derived state/verdicts from a caller.
 * This proves domain consistency, NOT that a receipt/evidence reference exists in a database. */
function validateState(state: DeliveryConsentState): void {
  if (
    !state ||
    !Array.isArray(state.receipts) ||
    !state.receipts.length ||
    state.receipts.length !== integer(state.version, 1)
  )
    fail('INVALID_STATE');
  const scope = normalizeScope(state.scope);
  let rebuilt: DeliveryConsentState | undefined;
  for (const receipt of state.receipts) {
    const actor = normalizeActor(receipt.actor);
    const command = normalizeCommand(receipt.command);
    if (
      receipt.commandId !== command.commandId ||
      receipt.resultVersion !== command.expectedVersion + 1 ||
      receipt.contentFingerprint !== commandFingerprint(scope, command, actor)
    )
      fail('INVALID_RECEIPT');
    if (rebuilt) rebuilt = transition(rebuilt, command, actor);
    else {
      if (command.kind !== 'PROPOSE') return fail('INITIAL_PROPOSAL_REQUIRED');
      rebuilt = createDeliveryProposal(scope, command, actor);
    }
    if (rebuilt.version !== receipt.resultVersion) fail('INVALID_RECEIPT');
  }
  // Compare canonical scalar trees independent of object key order (e.g. JSONB storage).
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  if (JSON.stringify(canonical(state)) !== JSON.stringify(canonical(rebuilt)))
    fail('INVALID_STATE');
}

export function createDeliveryProposal(
  scopeInput: DeliveryScope,
  commandInput: DeliveryProposalCommand,
  actorInput: DeliveryActor,
): DeliveryConsentState {
  const scope = normalizeScope(scopeInput);
  const command = normalizeCommand(commandInput);
  const actor = normalizeActor(actorInput);
  authorize(scope, command, actor);
  if (command.kind !== 'PROPOSE' || command.expectedVersion !== 0)
    return fail('INITIAL_PROPOSAL_REQUIRED');
  const receipt = {
    commandId: command.commandId,
    contentFingerprint: commandFingerprint(scope, command, actor),
    actor,
    command,
    resultVersion: 1,
  };
  return finish({
    version: 1,
    scope,
    quote: quoteFor(scope, command, 1),
    customerConsent: null,
    technicianConsent: null,
    actual: null,
    receipts: [receipt],
  });
}

/** Exact committed replay wins before CAS. It returns CURRENT state, never restores old consents.
 * The future transaction must enforce auth, unique command IDs and compare-and-swap atomically. */
function transition(
  state: DeliveryConsentState,
  command: DeliveryCommand,
  actor: DeliveryActor,
): DeliveryConsentState {
  const contentFingerprint = commandFingerprint(state.scope, command, actor);
  const previous = state.receipts.find(
    (receipt) => receipt.commandId === command.commandId,
  );
  if (previous) {
    if (previous.contentFingerprint !== contentFingerprint)
      fail('COMMAND_CONFLICT');
    return state;
  }
  authorize(state.scope, command, actor);
  if (command.expectedVersion !== state.version) fail('STALE_VERSION');
  const version = next(state.version);
  const receipt = {
    commandId: command.commandId,
    contentFingerprint,
    actor,
    command,
    resultVersion: version,
  };
  const updated = { ...state, version, receipts: [...state.receipts, receipt] };
  switch (command.kind) {
    case 'REVISE':
      return finish({
        ...updated,
        quote: quoteFor(state.scope, command, next(state.quote.quoteVersion)),
        customerConsent: null,
        technicianConsent: null,
        actual: null,
      });
    case 'CONSENT': {
      const quote = state.quote;
      if (
        command.quoteVersion !== quote.quoteVersion ||
        command.quoteFingerprint !== quote.fingerprint ||
        command.totalShippingFee !== quote.totalShippingFee ||
        command.shippingShare !==
          (actor.role === Role.CUSTOMER
            ? quote.customerShippingShare
            : quote.technicianShippingShare)
      )
        fail('QUOTE_MISMATCH');
      const field =
        actor.role === Role.CUSTOMER ? 'customerConsent' : 'technicianConsent';
      if (state[field]) fail('CONSENT_ALREADY_RECORDED');
      return finish({
        ...updated,
        [field]: { ...command, actor, contentFingerprint },
      });
    }
    case 'RECORD_ACTUAL':
      if (command.quoteVersion !== state.quote.quoteVersion)
        fail('QUOTE_MISMATCH');
      if (!state.customerConsent || !state.technicianConsent)
        fail('DUAL_CONSENT_REQUIRED');
      if (state.actual) fail('ACTUAL_ALREADY_RECORDED');
      if (command.totalShippingFee > state.quote.totalShippingFee)
        fail('RENEWED_DUAL_CONSENT_REQUIRED');
      return finish({
        ...updated,
        actual: {
          ...command,
          actor,
          contentFingerprint,
          approvedCeilingTotal: state.quote.totalShippingFee,
          ...calculateShippingShares(command.totalShippingFee, 'W3_70_30_V1'),
        },
      });
    default:
      return fail('PROPOSAL_ALREADY_EXISTS');
  }
}

export function applyDeliveryCommand(
  state: DeliveryConsentState,
  commandInput: DeliveryCommand,
  actorInput: DeliveryActor,
): DeliveryConsentState {
  validateState(state);
  return transition(
    immutable(state),
    normalizeCommand(commandInput),
    normalizeActor(actorInput),
  );
}
