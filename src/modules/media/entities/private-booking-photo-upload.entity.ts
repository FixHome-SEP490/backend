import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { Booking } from '../../bookings/entities/booking.entity';
import { User } from '../../users/entities/user.entity';

@Entity('booking_media_uploads')
@Check('ck_booking_media_uploads_size_bytes', '"size_bytes" > 0')
@Index('uq_booking_media_uploads_object_ref', ['objectRef'], { unique: true })
@Index('idx_booking_media_uploads_owner_expires_at', ['ownerUserId', 'expiresAt'])
export class PrivateBookingPhotoUpload extends BaseEntity {
  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'owner_user_id' })
  owner: User;

  @Column({ name: 'object_ref', type: 'varchar' })
  objectRef: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 30 })
  mimeType: string;

  @Column({ name: 'size_bytes', type: 'int' })
  sizeBytes: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'claimed_booking_id', type: 'uuid', nullable: true })
  claimedBookingId?: string | null;

  @ManyToOne(() => Booking, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'claimed_booking_id' })
  claimedBooking?: Booking | null;
}
