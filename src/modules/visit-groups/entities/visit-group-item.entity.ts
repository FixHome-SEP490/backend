import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { VisitGroup } from './visit-group.entity';

export type VisitDeviceOutcome = 'succeeded' | 'failed' | 'quote_declined' | 'interrupted';

/**
 * One physical device of a VisitGroup. `sequence` is 1 to 3 and unique in its
 * group (a database CHECK and unique index), so a group can never hold a fourth
 * device whatever the client sends. Quote, photos, parts and invoice live on the
 * child booking and its service order, not here.
 */
@Entity('visit_group_items')
@Index('uq_visit_group_items_sequence', ['groupId', 'sequence'], { unique: true })
@Index('uq_visit_group_items_booking', ['bookingId'], { unique: true })
export class VisitGroupItem extends BaseEntity {
  @Column({ name: 'group_id', type: 'uuid' })
  groupId: string;

  @ManyToOne(() => VisitGroup, (group) => group.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'group_id' })
  group?: VisitGroup;

  @Column({ type: 'smallint' })
  sequence: number;

  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId: string;

  @Column({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  /** What the customer calls this device ("Máy lạnh phòng ngủ"); optional. */
  @Column({ name: 'device_label', type: 'varchar', length: 80, nullable: true })
  deviceLabel?: string | null;

  /** The device's own result (PO 21/10/2026); only succeeded is charged. Null while open. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  outcome?: VisitDeviceOutcome | null;

  @Column({ name: 'outcome_reason', type: 'text', nullable: true })
  outcomeReason?: string | null;

  @Column({ name: 'outcome_at', type: 'timestamptz', nullable: true })
  outcomeAt?: Date | null;
}
