import { Column, Entity, JoinColumn, OneToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';

/**
 * The one bank account a technician withdraws to.
 *
 * Saved once and reused, so the account number is not retyped on every
 * withdrawal. It can only be saved when the holder name matches the name
 * captured at KYC approval (see BankAccountService). Each withdrawal copies
 * these fields onto itself, so editing the account later never changes where
 * an earlier withdrawal was sent.
 */
@Entity('technician_bank_accounts')
export class TechnicianBankAccount extends BaseEntity {
  @Column({ name: 'technician_id', type: 'uuid', unique: true })
  technicianId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'technician_id' })
  technician?: User;

  /** NAPAS BIN, what the payout API actually routes on. */
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
