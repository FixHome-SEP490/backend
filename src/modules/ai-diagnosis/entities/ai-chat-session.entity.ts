// src/modules/ai-diagnosis/entities/ai-chat-session.entity.ts
import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import type { AiChatSummaryState } from '../ai-chat-summary';

/**
 * Running summary of one assistant conversation, keyed by the AI Service's
 * session id. Written by the backend from the replies it proxies; a Booking
 * created with the same session id takes a frozen copy of it.
 *
 * customerId is the signed-in customer who held the conversation, when there
 * was one. A session owned by one customer is never attached to another's
 * booking.
 */
@Entity('ai_chat_sessions')
@Index('ux_ai_chat_sessions_session', ['sessionId'], { unique: true })
export class AiChatSession extends BaseEntity {
  @Column({ name: 'session_id', type: 'varchar', length: 128 })
  sessionId: string;

  @Column({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null;

  @Column({ type: 'jsonb' })
  summary: AiChatSummaryState;
}
