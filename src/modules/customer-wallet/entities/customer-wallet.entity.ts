import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { bigintTransformer } from '../../wallet/entities/wallet.entity';

/** A customer's wallet (PO 08/10/2026): top up, pay invoices, receive refunds; never withdraw. */
@Entity('customer_wallets')
export class CustomerWallet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  userId: string;

  @Column({ name: 'balance', type: 'bigint', default: 0, transformer: bigintTransformer })
  balance: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
