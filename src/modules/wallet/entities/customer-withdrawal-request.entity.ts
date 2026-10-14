import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { WithdrawalStatus } from '../../../shared/enums';
import { bigintTransformer } from './wallet.entity';

/**
 * A customer withdrawal (PO 14/10/2026), paid out at once like a technician
 * withdrawal: PROCESSING while payOS has it, then SUCCESS, or FAILED with the
 * amount returned to the customer wallet. The bank details are copied from the
 * saved account so editing it later never changes where this one went.
 */
@Entity('customer_withdrawal_requests')
@Index('idx_customer_withdrawal_customer', ['customerId', 'createdAt'])
@Index('idx_customer_withdrawal_status', ['status'])
@Index('uq_customer_withdrawal_open_per_wallet', ['walletId'], {
  unique: true,
  where: `"status" NOT IN ('SUCCESS', 'REJECTED', 'FAILED')`,
})
export class CustomerWithdrawalRequest extends BaseEntity {
  /** customer_wallets.id */
  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: number;

  @Column({ name: 'bank_bin', type: 'varchar', length: 8 })
  bankBin: string;

  @Column({ name: 'bank_name', type: 'varchar', length: 128 })
  bankName: string;

  @Column({ name: 'bank_account_number', type: 'varchar', length: 64 })
  bankAccountNumber: string;

  @Column({ name: 'bank_account_name', type: 'varchar', length: 128 })
  bankAccountName: string;

  /** PROCESSING, SUCCESS or FAILED (varchar + CHECK, see migration 0036). */
  @Column({ type: 'varchar', length: 16, default: WithdrawalStatus.PROCESSING })
  status: WithdrawalStatus;

  @Column({ name: 'requested_at', type: 'timestamptz', default: () => 'now()' })
  requestedAt: Date;

  /** The customer wallet debit (type withdrawal). */
  @Column({ name: 'transaction_id', type: 'uuid', nullable: true })
  transactionId?: string | null;

  @Column({ name: 'payout_id', type: 'varchar', length: 64, nullable: true })
  payoutId?: string | null;

  @Column({ name: 'payout_state', type: 'varchar', length: 32, nullable: true })
  payoutState?: string | null;

  @Column({ name: 'payout_bank_reference', type: 'varchar', length: 128, nullable: true })
  payoutBankReference?: string | null;

  @Column({ name: 'payout_attempted_at', type: 'timestamptz', nullable: true })
  payoutAttemptedAt?: Date | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason?: string | null;

  /** The withdrawal_refund transaction, when the payout failed. */
  @Column({ name: 'refund_transaction_id', type: 'uuid', nullable: true })
  refundTransactionId?: string | null;
}
