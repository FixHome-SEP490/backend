import {
  PayoutInstruction,
  PayoutProvider,
  PayoutRejectedError,
  PayoutResult,
} from './payout-provider';

/**
 * Stands in when no payout channel is configured (a development machine
 * without payOS keys). It never pretends a transfer happened: withdrawals are
 * refused before the wallet is touched (WithdrawalPayoutService.withdraw), and
 * if anything still reaches it the refusal is safe to refund.
 */
export class DisabledPayoutProvider implements PayoutProvider {
  readonly name = 'disabled' as const;

  createPayout(_instruction: PayoutInstruction, _idempotencyKey: string): Promise<PayoutResult> {
    return Promise.reject(new PayoutRejectedError('Chưa cấu hình cổng chi tiền payOS'));
  }

  findPayoutByReference(_referenceId: string): Promise<PayoutResult | null> {
    return Promise.resolve(null);
  }

  getSourceBalance(): Promise<number | null> {
    return Promise.resolve(null);
  }

  estimateCredit(instruction: PayoutInstruction): Promise<number> {
    return Promise.resolve(instruction.amount);
  }
}
