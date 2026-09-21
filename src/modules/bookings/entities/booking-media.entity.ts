// src/modules/bookings/entities/booking-media.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { Booking } from './booking.entity';

@Entity('booking_media')
@Index('ix_booking_media_booking', ['bookingId'])
@Index('uq_booking_media_private_upload', ['privateUploadId'], { unique: true })
export class BookingMedia extends BaseEntity {
  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId: string;

  @ManyToOne(() => Booking, (b) => b.media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id' })
  booking: Booking;

  @Column({ type: 'varchar' })
  url: string;

  @Column({ name: 'private_upload_id', type: 'uuid', nullable: true })
  privateUploadId: string | null;

  @Column({ name: 'mime_type', type: 'varchar', default: 'image/jpeg' })
  mimeType: string;

  @Column({ name: 'size_bytes', type: 'int', nullable: true })
  sizeBytes?: number | null;
}
