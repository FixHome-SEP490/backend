import { Column, Entity, JoinColumn, OneToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';

/**
 * The one bank account a customer withdraws to (PO 14/10/2026). Same rules
 * as the technician's: saved only after an approved identity check, with a
 * holder name matching the verified name; each withdrawal copies it.
 */
@Entity('customer_bank_accounts')
export class CustomerBankAccount extends BaseEntity {
  @Column({ name: 'customer_id', type: 'uuid', unique: true })
  customerId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer?: User;

  @Column({ name: 'bank_bin', type: 'varchar', length: 8 })
  bankBin: string;

  @Column({ name: 'bank_code', type: 'varchar', length: 32 })
  bankCode: string;

  @Column({ name: 'bank_name', type: 'varchar', length: 128 })
  bankName: string;

  @Column({ name: 'account_number', type: 'varchar', length: 32 })
  accountNumber: string;

  /** Stored in bank form: upper case, no accents. */
  @Column({ name: 'account_name', type: 'varchar', length: 128 })
  accountName: string;
}
