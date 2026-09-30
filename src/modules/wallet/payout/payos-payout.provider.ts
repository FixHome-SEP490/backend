// src/modules/wallet/payout/payos-payout.provider.ts
import { Logger } from '@nestjs/common';
import { APIError, PayOS } from '@payos/node';
import type { Payout, PayoutTransaction } from '@payos/node';
import {
  PayoutInstruction,
  PayoutOutcome,
  PayoutProvider,
  PayoutRejectedError,
  PayoutResult,
  PayoutUnknownError,
} from './payout-provider';

export interface PayosPayoutCredentials {
  clientId: string;
  apiKey: string;
  checksumKey: string;
}

/**
 * Real payouts through payOS "chi hộ", funded from the Bảo Kim wallet linked
 * to the payOS account.
 *
 * The credentials are those of the payout channel, which payOS issues
 * separately from the payment-link channel; the SDK's own PAYOS_* defaults are
 * never used so the two can never be mixed up.
 */
export class PayosPayoutProvider implements PayoutProvider {
  readonly name = 'payos' as const;
  private readonly logger = new Logger(PayosPayoutProvider.name);
  private readonly client: PayOS;

  constructor(credentials: PayosPayoutCredentials) {
    this.client = new PayOS({
      clientId: credentials.clientId,
      apiKey: credentials.apiKey,
      checksumKey: credentials.checksumKey,
      timeout: 30_000,
      // Retries reuse the same idempotency key, so payOS will not pay twice.
      maxRetries: 2,
      logLevel: 'off',
    });
  }

  async createPayout(
    instruction: PayoutInstruction,
    idempotencyKey: string,
  ): Promise<PayoutResult> {
    try {
      const payout = await this.client.payouts.create(
        {
          referenceId: instruction.referenceId,
          amount: instruction.amount,
          description: instruction.description,
          toBin: instruction.toBin,
          toAccountNumber: instruction.toAccountNumber,
          category: ['withdrawal'],
        },
        idempotencyKey,
      );
      return this.toResult(payout);
    } catch (error) {
      throw this.classify(error);
    }
  }

  async findPayoutByReference(
    referenceId: string,
  ): Promise<PayoutResult | null> {
    try {
      const page = await this.client.payouts.list({ referenceId, limit: 1 });
      const [payout] = page.data;
      return payout ? this.toResult(payout) : null;
    } catch (error) {
      // A failed lookup tells us nothing about the payout itself.
      throw new PayoutUnknownError(this.describe(error));
    }
  }

  async getSourceBalance(): Promise<number | null> {
    try {
      const account = await this.client.payoutsAccount.balance();
      const balance = Number(account.balance);
      return Number.isFinite(balance) ? balance : null;
    } catch (error) {
      this.logger.warn(`Could not read payOS payout balance: ${this.describe(error)}`);
      return null;
    }
  }

  async estimateCredit(instruction: PayoutInstruction): Promise<number> {
    try {
      const estimate = await this.client.payouts.estimateCredit({
        referenceId: instruction.referenceId,
        amount: instruction.amount,
        description: instruction.description,
        toBin: instruction.toBin,
        toAccountNumber: instruction.toAccountNumber,
      });
      return Number(estimate.estimateCredit);
    } catch (error) {
      // Without an estimate, the amount itself is the least the source needs.
      this.logger.warn(`Could not estimate payOS payout credit: ${this.describe(error)}`);
      return instruction.amount;
    }
  }

  private toResult(payout: Payout): PayoutResult {
    const transaction: PayoutTransaction | undefined = payout.transactions?.[0];
    const providerState = transaction?.state ?? payout.approvalState;
    return {
      payoutId: payout.id,
      outcome: this.outcomeOf(payout, transaction),
      providerState,
      bankReference: transaction?.reference ?? null,
      failureReason: transaction?.errorMessage ?? null,
    };
  }

  private outcomeOf(
    payout: Payout,
    transaction: PayoutTransaction | undefined,
  ): PayoutOutcome {
    switch (transaction?.state) {
      case 'SUCCEEDED':
        return 'SUCCEEDED';
      case 'FAILED':
      case 'CANCELLED':
      // Money left and came back to the source: from the technician's side the
      // withdrawal did not happen.
      case 'REVERSED':
        return 'FAILED';
      case 'RECEIVED':
      case 'PROCESSING':
      case 'ON_HOLD':
        return 'PROCESSING';
      default:
        break;
    }
    // No transaction yet: fall back to the batch-level approval state.
    if (['REJECTED', 'CANCELLED', 'FAILED'].includes(payout.approvalState)) {
      return 'FAILED';
    }
    return 'PROCESSING';
  }

  /**
   * A response with a status below 500 means payOS read the request and said
   * no, so no transfer was started. Anything else — no response at all, a
   * timeout, a 5xx — leaves the outcome unknown.
   */
  private classify(error: unknown): Error {
    if (
      error instanceof APIError &&
      (error.status === 401 || error.status === 403)
    ) {
      // Our own setup is wrong (keys, or this server's IP not whitelisted).
      // Nothing the technician can act on, and they read failureReason in
      // their history, so they get a plain sentence; the detail is logged.
      this.logger.error(
        `payOS refused our credentials or IP (${error.status}): ${this.describe(error)}`,
      );
      return new PayoutRejectedError(
        'Kênh chi hộ đang tạm ngưng, vui lòng thử lại sau',
      );
    }
    if (
      error instanceof APIError &&
      typeof error.status === 'number' &&
      error.status < 500
    ) {
      return new PayoutRejectedError(this.describe(error));
    }
    return new PayoutUnknownError(this.describe(error));
  }

  private describe(error: unknown): string {
    if (error instanceof APIError) {
      return [error.code, error.desc ?? error.message].filter(Boolean).join(': ');
    }
    return error instanceof Error ? error.message : String(error);
  }
}
