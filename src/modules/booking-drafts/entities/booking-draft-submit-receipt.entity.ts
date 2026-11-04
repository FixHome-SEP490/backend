import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Booking } from '../../bookings/entities/booking.entity';
import { VisitGroup } from '../../visit-groups/entities/visit-group.entity';

/** Independent of the active draft: A's receipt survives creation/discard/expiry of B. */
@Entity('booking_draft_submit_receipts')
@Index('uq_booking_draft_receipt_operation', ['customerId', 'draftId', 'operationKey'], { unique: true })
@Index('uq_booking_draft_receipt_generation', ['customerId', 'draftId'], { unique: true })
export class BookingDraftSubmitReceipt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  // Deliberately no FK to the consumed/deleted booking_drafts row.
  @Column({ name: 'draft_id', type: 'uuid' })
  draftId: string;

  @Column({ name: 'operation_key', type: 'uuid' })
  operationKey: string;

  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint: string;

  @Column({ type: 'varchar', length: 16 })
  kind: 'booking' | 'visit_group';

  @Column({ name: 'booking_id', type: 'uuid', nullable: true })
  bookingId: string | null;

  @ManyToOne(() => Booking, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id' })
  booking: Booking | null;

  @Column({ name: 'visit_group_id', type: 'uuid', nullable: true })
  visitGroupId: string | null;

  @ManyToOne(() => VisitGroup, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'visit_group_id' })
  visitGroup: VisitGroup | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Minimum retention marker, never a replay expiry; no receipt pruning in this feature. */
  @Column({ name: 'retain_until', type: 'timestamptz' })
  retainUntil: Date;
}
