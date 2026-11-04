import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';
import type { SafeDraftSnapshot } from '../booking-draft.dto';

@Entity('booking_drafts')
@Index('uq_booking_drafts_customer', ['customerId'], { unique: true })
export class BookingDraft extends BaseEntity {
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column({ type: 'integer', default: 1 })
  version: number;

  @Column({ type: 'jsonb' })
  snapshot: SafeDraftSnapshot;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
