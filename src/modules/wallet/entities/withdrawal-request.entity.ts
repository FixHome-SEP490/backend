import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { WithdrawalStatus } from '../../../shared/enums';
import { User } from '../../users/entities/user.entity';
import { Wallet, bigintTransformer } from './wallet.entity';
import { WalletTransaction } from './wallet-transaction.entity';

@Entity('withdrawal_requests')
@Index('idx_withdrawal_technician', ['technicianId', 'createdAt'])
@Index('idx_withdrawal_status', ['status'])
@Index('uq_pending_withdrawal_per_wallet', ['walletId'], {
  unique: true,
  where: `"status" = 'PENDING'`,
})
export class WithdrawalRequest extends BaseEntity {
  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId: string;

  @ManyToOne(() => Wallet, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'wallet_id' })
  wallet?: Wallet;

  @Column({ name: 'technician_id', type: 'uuid' })
  technicianId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'technician_id' })
  technician?: User;

  @Column({
    type: 'bigint',
    transformer: bigintTransformer,
  })
  amount: number;

  @Column({ name: 'bank_name', type: 'varchar', length: 128, nullable: true })
  bankName?: string | null;

  @Column({ name: 'bank_account_number', type: 'varchar', length: 64, nullable: true })
  bankAccountNumber?: string | null;

  @Column({ name: 'bank_account_name', type: 'varchar', length: 128, nullable: true })
  bankAccountName?: string | null;

  @Column({
    type: 'enum',
    enum: WithdrawalStatus,
    enumName: 'withdrawal_status_enum',
    default: WithdrawalStatus.PENDING,
  })
  status: WithdrawalStatus;

  @Column({ name: 'requested_at', type: 'timestamptz', default: () => 'now()' })
  requestedAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date | null;

  @Column({ name: 'processed_by_user_id', type: 'uuid', nullable: true })
  processedByUserId?: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'processed_by_user_id' })
  processedByUser?: User | null;

  @Column({ name: 'reject_reason', type: 'text', nullable: true })
  rejectReason?: string | null;

  @Column({ name: 'transaction_id', type: 'uuid', nullable: true })
  transactionId?: string | null;

  @ManyToOne(() => WalletTransaction, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'transaction_id' })
  transaction?: WalletTransaction | null;
}
