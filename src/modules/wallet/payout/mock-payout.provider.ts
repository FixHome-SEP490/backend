// src/modules/wallet/payout/mock-payout.provider.ts
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  PayoutInstruction,
  PayoutProvider,
  PayoutRejectedError,
  PayoutResult,
} from './payout-provider';

/**
 * A stand-in for payOS so the whole withdrawal flow can be exercised without
 * spending money. payOS has no sandbox, which is the only reason this exists.
 *
 * The receiving account number decides what happens, so every branch of the
 * flow can be reached on purpose from the UI:
 *
 *   ends in 0000  payOS rejects the payout       -> FAILED, amount refunded
 *   ends in 9999  payout accepted but pending     -> PROCESSING, then SUCCESS
 *                                                    on the next reconcile
 *   anything else paid immediately               -> SUCCESS
 *
 * State lives in memory and is lost on restart. That is fine for a simulator,
 * and it also exercises the "provider has never heard of it" recovery path.
 * Refused outright in production by the factory.
 */
export class MockPayoutProvider implements PayoutProvider {
  readonly name = 'mock' as const;
  private readonly logger = new Logger(MockPayoutProvider.name);
  private readonly payouts = new Map<string, PayoutResult>();
  private balance: number;

  constructor(initialBalance: number) {
    this.balance = initialBalance;
  }

  async createPayout(
    instruction: PayoutInstruction,
    _idempotencyKey: string,
  ): Promise<PayoutResult> {
    // Same reference twice returns the first answer, like an idempotent API.
    const existing = this.payouts.get(instruction.referenceId);
    if (existing) return existing;

    if (instruction.toAccountNumber.endsWith('0000')) {
      throw new PayoutRejectedError(
        'Số tài khoản nhận không tồn tại (giả lập)',
      );
    }
    if (instruction.amount > this.balance) {
      throw new PayoutRejectedError('Ví nguồn không đủ số dư (giả lập)');
    }

    this.balance -= instruction.amount;
    const pending = instruction.toAccountNumber.endsWith('9999');
    const result: PayoutResult = {
      payoutId: `mock_${randomUUID()}`,
      outcome: pending ? 'PROCESSING' : 'SUCCEEDED',
      providerState: pending ? 'PROCESSING' : 'SUCCEEDED',
      bankReference: pending ? null : `MOCK${Date.now()}`,
      failureReason: null,
    };
    this.payouts.set(instruction.referenceId, result);
    this.logger.log(
      `Simulated payout ${instruction.amount} to ${instruction.toBin}/${instruction.toAccountNumber}: ${result.outcome}`,
    );
    return result;
  }

  async findPayoutByReference(
    referenceId: string,
  ): Promise<PayoutResult | null> {
    const found = this.payouts.get(referenceId);
    if (!found) return null;
    if (found.outcome === 'PROCESSING') {
      // A pending simulated payout settles the first time anyone asks.
      const settled: PayoutResult = {
        ...found,
        outcome: 'SUCCEEDED',
        providerState: 'SUCCEEDED',
        bankReference: `MOCK${Date.now()}`,
      };
      this.payouts.set(referenceId, settled);
      return settled;
    }
    return found;
  }

  async getSourceBalance(): Promise<number | null> {
    return this.balance;
  }

  async estimateCredit(instruction: PayoutInstruction): Promise<number> {
    return instruction.amount;
  }
}
