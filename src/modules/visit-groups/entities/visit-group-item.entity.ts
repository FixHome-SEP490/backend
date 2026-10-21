import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { VisitGroup } from './visit-group.entity';

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
}
