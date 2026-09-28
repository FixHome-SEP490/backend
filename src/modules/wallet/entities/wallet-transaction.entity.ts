import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { WalletTransactionType } from '../../../shared/enums';
import { Wallet, bigintTransformer } from './wallet.entity';

@Entity('wallet_transactions')
@Index('uq_wallet_tx_idempotency_key', ['idempotencyKey'], { unique: true })
@Index('idx_wallet_tx_wallet_created', ['walletId', 'createdAt'])
@Index('idx_wallet_tx_type', ['type'])
@Index('idx_wallet_tx_ref', ['referenceType', 'referenceId'])
export class WalletTransaction extends BaseEntity {
  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId: string;

  @ManyToOne(() => Wallet, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'wallet_id' })
  wallet?: Wallet;

  @Column({
    type: 'enum',
    enum: WalletTransactionType,
    enumName: 'wallet_transaction_type_enum',
  })
  type: WalletTransactionType;

  @Column({
    type: 'bigint',
    transformer: bigintTransformer,
  })
  amount: number;

  @Column({
    name: 'balance_before',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  balanceBefore: number;

  @Column({
    name: 'balance_after',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  balanceAfter: number;

  @Column({ name: 'reference_type', type: 'varchar', length: 64, nullable: true })
  referenceType?: string | null;

  @Column({ name: 'reference_id', type: 'varchar', length: 128, nullable: true })
  referenceId?: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;
}
