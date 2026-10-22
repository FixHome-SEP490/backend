import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type VisitPaymentRail = 'vnpay' | 'wallet' | 'cash';
export type VisitPaymentStatus = 'pending' | 'pending_confirmation' | 'verified' | 'failed' | 'cancelled' | 'disputed';

/** How a visit payment splits over the devices' invoices, frozen when the attempt starts. */
export interface VisitPaymentAllocation {
  invoiceId: string;
  serviceOrderId: string;
  amount: number;
}

/**
 * One attempt to pay a whole visit (PO 21/10/2026): VNPay pending until its
 * IPN, wallet verified at once, cash pending_confirmation until the customer
 * confirms. At most one verified attempt per visit (partial unique index).
 */
@Entity('visit_group_payments')
@Index('uq_visit_group_payments_idempotency', ['idempotencyKey'], { unique: true })
export class VisitGroupPayment extends BaseEntity {
  @Column({ name: 'visit_group_id', type: 'uuid' })
  visitGroupId: string;

  @Column({ type: 'varchar', length: 8 })
  rail: VisitPaymentRail;

  @Column({ type: 'varchar', length: 24 })
  status: VisitPaymentStatus;

  @Column({ type: 'bigint' })
  amount: number;

  @Column({ type: 'jsonb' })
  allocations: VisitPaymentAllocation[];

  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;

  @Column({ name: 'provider_reference', type: 'varchar', length: 255, nullable: true })
  providerReference?: string | null;

  @Column({ name: 'requested_by_user_id', type: 'uuid' })
  requestedByUserId: string;

  @Column({ name: 'requested_at', type: 'timestamptz', default: () => 'now()' })
  requestedAt: Date;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt?: Date | null;

  @Column({ name: 'failure_code', type: 'varchar', length: 64, nullable: true })
  failureCode?: string | null;
}
