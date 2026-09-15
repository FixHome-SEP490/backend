// src/modules/notifications/entities/notification.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';

@Entity('notifications')
@Index('idx_notifications_user_id', ['userId'])
@Index('idx_notifications_user_unread', ['userId', 'isRead'])
export class Notification extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'varchar', length: 50, default: 'INFO' })
  type: string;

  @Column({ name: 'reference_id', type: 'uuid', nullable: true })
  referenceId?: string | null;

  @Column({ name: 'reference_type', type: 'varchar', length: 50, nullable: true })
  referenceType?: string | null;

  @Column({ name: 'is_read', type: 'boolean', default: false })
  isRead: boolean;
}
