// src/modules/messaging/entities/conversation.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { Booking } from '../../bookings/entities/booking.entity';
import { ServiceOrder } from '../../service-orders/entities/service-order.entity';
import { User } from '../../users/entities/user.entity';
import { ConversationStatus } from '../../../shared/enums';

/**
 * Spec 8.6 / CHAT-BR-01.
 *
 * A conversation exists only for a (Booking, Technician) pair and is opened when
 * that Technician actually receives the Booking (invitation becomes PENDING).
 * There is no standalone conversation outside a Booking, and no free chat before
 * the Booking exists. Pre-booking contact stays unimplemented while TBD-CHAT-01
 * is open.
 */
@Entity('conversations')
@Unique('uq_conversation_booking_technician', ['bookingId', 'technicianId'])
@Index('ix_conversations_customer', ['customerId', 'lastMessageAt'])
@Index('ix_conversations_technician', ['technicianId', 'lastMessageAt'])
@Index('ix_conversations_service_order', ['serviceOrderId'])
export class Conversation extends BaseEntity {
  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId: string;

  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id' })
  booking: Booking;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column({ name: 'technician_id', type: 'uuid' })
  technicianId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'technician_id' })
  technician: User;

  /** Set when this technician accepts; the conversation then follows the order. */
  @Column({ name: 'service_order_id', type: 'uuid', nullable: true })
  serviceOrderId?: string | null;

  @ManyToOne(() => ServiceOrder, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'service_order_id' })
  serviceOrder?: ServiceOrder | null;

  @Column({
    type: 'enum',
    enum: ConversationStatus,
    default: ConversationStatus.ACTIVE,
  })
  status: ConversationStatus;

  /** Service name snapshot so the thread list can show what was booked. */
  @Column({
    name: 'service_name_snapshot',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  serviceNameSnapshot?: string | null;

  @Column({ name: 'last_message_at', type: 'timestamptz', nullable: true })
  lastMessageAt?: Date | null;

  @Column({
    name: 'last_message_preview',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  lastMessagePreview?: string | null;

  /** Denormalised read cursors; cheap unread counts without scanning messages. */
  @Column({ name: 'customer_last_read_at', type: 'timestamptz', nullable: true })
  customerLastReadAt?: Date | null;

  @Column({
    name: 'technician_last_read_at',
    type: 'timestamptz',
    nullable: true,
  })
  technicianLastReadAt?: Date | null;
}
