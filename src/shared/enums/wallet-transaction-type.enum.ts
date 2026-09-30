export enum WalletTransactionType {
  TOP_UP = 'TOP_UP',
  WITHDRAW = 'WITHDRAW',
  /** Money returned to the wallet because a withdrawal payout failed. */
  WITHDRAW_REFUND = 'WITHDRAW_REFUND',
  ONLINE_EARNING = 'ONLINE_EARNING',
  PLATFORM_FEE = 'PLATFORM_FEE',
  ADJUSTMENT = 'ADJUSTMENT',
}
