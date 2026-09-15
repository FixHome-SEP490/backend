// src/modules/bookings/entities/chat-message.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { Conversation } from './conversation.entity';
import { User } from '../../users/entities/user.entity';

@Entity('chat_messages')
@Index('idx_chat_messages_conversation_id', ['conversationId'])
export class ChatMessage extends BaseEntity {
  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Conversation, (c) => c.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  @Column({ name: 'sender_id', type: 'uuid' })
  senderId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sender_id' })
  sender: User;

  @Column({ type: 'text' })
  content: string;
}
