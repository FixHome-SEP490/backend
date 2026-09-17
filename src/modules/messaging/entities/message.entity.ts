// src/modules/messaging/entities/message.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { Conversation } from './conversation.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Spec 12 lists Message as a persisted entity and 8.23 fixes the order:
 * validate, persist, COMMIT, then publish over WebSocket. Nothing is ever
 * broadcast before it is durable, so history and realtime never disagree.
 *
 * Retraction ("gỡ tin nhắn") is a soft delete: the row stays so the thread keeps
 * its order and both sides see the same tombstone.
 */
@Entity('messages')
@Index('ix_messages_conversation_created', ['conversationId', 'createdAt'])
@Index('ix_messages_sender', ['senderId'])
export class Message extends BaseEntity {
  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  @Column({ name: 'sender_id', type: 'uuid' })
  senderId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sender_id' })
  sender: User;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'edited_at', type: 'timestamptz', nullable: true })
  editedAt?: Date | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null;

  /**
   * Client-generated id echoed back so the sender can reconcile its optimistic
   * bubble with the persisted row instead of rendering the message twice.
   */
  @Column({
    name: 'client_message_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  clientMessageId?: string | null;
}
