import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { bigintTransformer } from '../../wallet/entities/wallet.entity';

export type CustomerWalletTransactionType = 'top_up' | 'invoice_payment' | 'refund' | 'adjustment_credit' | 'adjustment_debit';

/** One balance change, never edited afterwards; the idempotency key makes a retry a no-op. */
@Entity('customer_wallet_transactions')
@Index(['walletId', 'createdAt'])
export class CustomerWalletTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId: string;

  @Column({ name: 'type', type: 'varchar', length: 20 })
  type: CustomerWalletTransactionType;

  /** Always positive; the type says whether it came in or went out. */
  @Column({ name: 'amount', type: 'bigint', transformer: bigintTransformer })
  amount: number;

  @Column({ name: 'balance_before', type: 'bigint', transformer: bigintTransformer })
  balanceBefore: number;

  @Column({ name: 'balance_after', type: 'bigint', transformer: bigintTransformer })
  balanceAfter: number;

  @Column({ name: 'reference_type', type: 'varchar', length: 32, nullable: true })
  referenceType: string | null;

  @Column({ name: 'reference_id', type: 'varchar', length: 128, nullable: true })
  referenceId: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 160, unique: true })
  idempotencyKey: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
