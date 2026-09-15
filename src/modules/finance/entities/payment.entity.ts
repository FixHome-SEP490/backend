import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import {
  PaymentAttemptStatus,
  PaymentMode,
  PaymentPurpose,
} from '../../../shared/enums';

@Entity('payments')
@Index('uq_payments_idempotency_key', ['idempotencyKey'], { unique: true })
@Index('uq_payments_provider_reference', ['providerReference'], {
  unique: true,
  where: '"provider_reference" IS NOT NULL',
})
@Index('idx_payments_invoice_created_at', ['invoiceId', 'createdAt'])
@Index('idx_payments_commission_due_created_at', [
  'commissionDueId',
  'createdAt',
])
export class Payment extends BaseEntity {
  @Column({ name: 'invoice_id', type: 'uuid', nullable: true })
  invoiceId?: string | null;

  @Column({ name: 'commission_due_id', type: 'uuid', nullable: true })
  commissionDueId?: string | null;

  @Column({
    type: 'enum',
    enum: PaymentPurpose,
    enumName: 'payment_purpose_enum',
  })
  purpose: PaymentPurpose;

  @Column({ type: 'bigint' })
  amount: number;

  @Column({ type: 'varchar', length: 3, default: 'VND' })
  currency: string;

  @Column({
    type: 'enum',
    enum: PaymentMode,
    enumName: 'payment_mode_enum',
  })
  mode: PaymentMode;

  @Column({ type: 'varchar', length: 64, nullable: true })
  provider?: string | null;

  @Column({
    type: 'enum',
    enum: PaymentAttemptStatus,
    enumName: 'payment_attempt_status_enum',
    default: PaymentAttemptStatus.PENDING,
  })
  status: PaymentAttemptStatus;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;

  @Column({ name: 'provider_reference', type: 'varchar', length: 255, nullable: true })
  providerReference?: string | null;

  @Column({ name: 'requested_by_user_id', type: 'uuid' })
  requestedByUserId: string;

  @Column({ name: 'failure_code', type: 'varchar', length: 64, nullable: true })
  failureCode?: string | null;

  @Column({ name: 'requested_at', type: 'timestamptz', default: () => 'now()' })
  requestedAt: Date;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt?: Date | null;
}
