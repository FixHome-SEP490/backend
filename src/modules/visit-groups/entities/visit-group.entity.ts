import { Column, Entity, Index, OneToMany, VersionColumn } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { VisitGroupItem } from './visit-group-item.entity';

export const VISIT_GROUP_STATUSES = ['submitted', 'cancelled'] as const;
export type VisitGroupStatus = (typeof VISIT_GROUP_STATUSES)[number];

/**
 * One visit for up to three physical devices of one customer (PO 21/10/2026):
 * one address, one arrival session, one technician, one payment. Every device
 * is its own child Booking (quantity 1); the group only holds them together.
 */
@Entity('visit_groups')
@Index('uq_visit_groups_customer_idempotency', ['customerId', 'idempotencyKey'], { unique: true, where: '"idempotency_key" IS NOT NULL' })
export class VisitGroup extends BaseEntity {
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ name: 'address_id', type: 'uuid' })
  addressId: string;

  @Column({ type: 'varchar', length: 16, default: 'submitted' })
  status: VisitGroupStatus;

  /** The arrival window every device shares, as written on the child bookings. */
  @Column({ name: 'booking_mode', type: 'varchar', length: 16 })
  bookingMode: 'scheduled' | 'urgent';

  @Column({ type: 'varchar', length: 16, nullable: true })
  slot?: 'morning' | 'afternoon' | 'evening' | null;

  @Column({ name: 'preferred_start_at', type: 'timestamptz' })
  preferredStartAt: Date;

  @Column({ name: 'preferred_end_at', type: 'timestamptz' })
  preferredEndAt: Date;

  /** A retried submission with the same key returns the first group instead of a second one. */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true })
  idempotencyKey?: string | null;

  @VersionColumn()
  version: number;

  @OneToMany(() => VisitGroupItem, (item) => item.group)
  items?: VisitGroupItem[];
}
