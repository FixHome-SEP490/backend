import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { VerificationStatus } from '../../../shared/enums';
import { User } from '../../users/entities/user.entity';
import { CustomerVerificationDocument } from './customer-verification-document.entity';

/**
 * A customer's identity check (PO 14/10/2026), needed before they can save a
 * bank account or withdraw the customer wallet. The personal details are
 * copied here as the customer confirmed them against the card, so what the
 * admin approved never changes when the profile does.
 */
@Entity('customer_verifications')
@Index('idx_customer_verification_customer', ['customerId', 'submittedAt'])
@Index('idx_customer_verification_status', ['status', 'submittedAt'])
@Index('uq_customer_verification_open', ['customerId'], {
  unique: true,
  where: `"status" IN ('pending', 'verified')`,
})
export class CustomerVerification extends BaseEntity {
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer?: User;

  @Column({ name: 'status', type: 'varchar', length: 16, default: VerificationStatus.PENDING })
  status: VerificationStatus;

  @Column({ name: 'full_name', type: 'varchar', length: 200 })
  fullName: string;

  /** Calendar date as on the card, YYYY-MM-DD. */
  @Column({ name: 'date_of_birth', type: 'date' })
  dateOfBirth: string;

  @Column({ name: 'gender', type: 'varchar', length: 10 })
  gender: string;

  @Column({ name: 'citizen_id_number', type: 'varchar', length: 12 })
  citizenIdNumber: string;

  @Column({ name: 'full_address', type: 'varchar', length: 500 })
  fullAddress: string;

  @Column({ name: 'submitted_at', type: 'timestamptz', default: () => 'now()' })
  submittedAt: Date;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewed_by' })
  reviewedBy?: User | null;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason: string | null;

  /**
   * The name frozen at approval. The bank account holder name is checked
   * against this, never against the live profile.
   */
  @Column({ name: 'verified_full_name', type: 'varchar', length: 255, nullable: true })
  verifiedFullName: string | null;

  @OneToMany(() => CustomerVerificationDocument, (doc) => doc.verification)
  documents?: CustomerVerificationDocument[];
}
