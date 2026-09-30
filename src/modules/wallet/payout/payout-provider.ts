// src/modules/wallet/payout/payout-provider.ts

/**
 * What the withdrawal flow needs from whoever actually moves the money.
 *
 * Two implementations exist: payOS for real payouts, and a simulator for
 * development, because payOS has no sandbox and every real call spends real
 * money. The withdrawal flow only ever talks to this interface.
 */
export const PAYOUT_PROVIDER = Symbol('PAYOUT_PROVIDER');

export type PayoutProviderName = 'payos' | 'mock';

/** The three outcomes the withdrawal flow acts on. */
export type PayoutOutcome = 'SUCCEEDED' | 'PROCESSING' | 'FAILED';

export interface PayoutInstruction {
  /** Deterministic per withdrawal, so a lost response can be looked up again. */
  referenceId: string;
  amount: number;
  description: string;
  /** NAPAS BIN of the receiving bank. */
  toBin: string;
  toAccountNumber: string;
}

export interface PayoutResult {
  payoutId: string | null;
  outcome: PayoutOutcome;
  /** The provider's own state, kept verbatim for support. */
  providerState: string;
  /** Reference the bank printed on the transfer, when there is one. */
  bankReference: string | null;
  failureReason: string | null;
}

export interface PayoutProvider {
  readonly name: PayoutProviderName;

  /**
   * Send one payout. Resolves with the provider's answer, or throws one of the
   * two errors below — never anything else — so the caller always knows
   * whether money may have left.
   */
  createPayout(
    instruction: PayoutInstruction,
    idempotencyKey: string,
  ): Promise<PayoutResult>;

  /** Null means the provider has no payout under this reference at all. */
  findPayoutByReference(referenceId: string): Promise<PayoutResult | null>;

  /** Balance of the funding source, or null when it cannot be read. */
  getSourceBalance(): Promise<number | null>;

  /** Credit the funding source needs for this payout, fees included. */
  estimateCredit(instruction: PayoutInstruction): Promise<number>;
}

/**
 * The provider refused the request outright. It never started a transfer, so
 * returning the amount to the technician's wallet is safe.
 */
export class PayoutRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayoutRejectedError';
  }
}

/**
 * The request may or may not have reached the provider — a timeout, a dropped
 * connection, a 5xx. Refunding now could pay the technician twice, so the
 * withdrawal stays PROCESSING until the reconciler finds out what happened.
 */
export class PayoutUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayoutUnknownError';
  }
}
