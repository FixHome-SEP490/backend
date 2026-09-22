import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { Booking } from './booking.entity';
import { BookingInvitation } from './booking-invitation.entity';

@Entity('booking_invitation_groups')
@Index('ix_booking_invitation_groups_booking', ['bookingId'])
export class BookingInvitationGroup extends BaseEntity {
  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId: string;

  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id' })
  booking: Booking;

  @Column({ name: 'extension_used_at', type: 'timestamptz', nullable: true })
  extensionUsedAt?: Date | null;

  @OneToMany(() => BookingInvitation, (invitation) => invitation.group)
  invitations: BookingInvitation[];
}
