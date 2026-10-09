import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

/** One change of a user's reputation points, with why and who made it. */
@Entity('reputation_events')
@Index(['userId', 'createdAt'])
export class ReputationEvent extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** violation | adjustment | reset */
  @Column({ name: 'kind', type: 'varchar', length: 20 })
  kind: 'violation' | 'adjustment' | 'reset';

  @Column({ name: 'delta', type: 'int' })
  delta: number;

  @Column({ name: 'points_after', type: 'int' })
  pointsAfter: number;

  @Column({ name: 'reason', type: 'text' })
  reason: string;

  /** Penalty applied with this change: none, a suspension until a time, or a lock. */
  @Column({ name: 'penalty', type: 'varchar', length: 40, nullable: true })
  penalty?: string | null;

  @Column({ name: 'service_order_id', type: 'uuid', nullable: true })
  serviceOrderId?: string | null;

  @Column({ name: 'cancellation_id', type: 'uuid', nullable: true })
  cancellationId?: string | null;

  /** Staff member for an adjustment; null for automatic changes. */
  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId?: string | null;
}
