export enum WithdrawalStatus {
  /** Waiting for a Service Manager. Nothing has left the wallet yet. */
  PENDING = 'PENDING',
  /**
   * Approved and debited; the payout has been handed to payOS and its final
   * outcome is not known yet. Money is out of the wallet but not yet confirmed
   * in the bank, so this state must always end in SUCCESS or FAILED.
   */
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  REJECTED = 'REJECTED',
  /** The payout did not go through; the amount has been returned to the wallet. */
  FAILED = 'FAILED',
}
