// src/modules/ai-diagnosis/entities/ai-chat-turn.entity.ts
import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

/**
 * One message of an assistant conversation and what came back (PO 01/11/2026).
 *
 * `clientMessageId` is the client's own id for the message: the same message
 * sent twice (a retry on a weak connection, a double tap) gets the reply
 * already given instead of a second, different diagnosis. The rest is for
 * measuring the assistant: how long it took, which model and knowledge base
 * answered, and the state version it left.
 */
@Entity('ai_chat_turns')
@Index('ix_ai_chat_turns_session_created', ['sessionId', 'createdAt'])
export class AiChatTurn extends BaseEntity {
  @Column({ name: 'session_id', type: 'varchar', length: 128 })
  sessionId: string;

  @Column({ name: 'client_message_id', type: 'varchar', length: 64, nullable: true })
  clientMessageId?: string | null;

  @Column({ type: 'varchar', length: 16 })
  route: 'analyze' | 'ask';

  @Column({ type: 'varchar', length: 32 })
  status: string;

  @Column({ name: 'state_version', type: 'int', nullable: true })
  stateVersion?: number | null;

  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs?: number | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  model?: string | null;

  @Column({ name: 'kb_version', type: 'varchar', length: 40, nullable: true })
  kbVersion?: string | null;

  /** The reply as the client received it, for answering a repeated message. */
  @Column({ type: 'jsonb', nullable: true })
  response?: Record<string, unknown> | null;
}
