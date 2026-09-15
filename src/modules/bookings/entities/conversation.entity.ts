// src/modules/bookings/entities/conversation.entity.ts
import { Entity, Column, OneToMany, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { ChatMessage } from './chat-message.entity';

@Entity('conversations')
@Index('idx_conversations_booking_id', ['bookingId'], { unique: true })
export class Conversation extends BaseEntity {
  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId: string;

  @OneToMany(() => ChatMessage, (msg) => msg.conversation)
  messages: ChatMessage[];
}
