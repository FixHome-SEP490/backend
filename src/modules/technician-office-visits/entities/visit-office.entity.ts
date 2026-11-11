import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

const numeric = { to: (v?: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) };

/** Trụ sở nơi thợ lên gặp trực tiếp sau khi được xác nhận danh tính. Admin cấu hình. */
@Entity('technician_visit_offices')
export class VisitOffice extends BaseEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 500 })
  address: string;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true, transformer: numeric })
  latitude: number | null;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true, transformer: numeric })
  longitude: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  /** 1 = thứ hai … 7 = chủ nhật. */
  @Column({ name: 'visit_days', type: 'smallint', array: true, default: () => "'{1,2,3,4,5}'" })
  visitDays: number[];

  /** `HH:mm`, giờ Việt Nam. */
  @Column({ name: 'open_time', type: 'time', default: '08:00' })
  openTime: string;

  @Column({ name: 'close_time', type: 'time', default: '17:00' })
  closeTime: string;

  @Column({ name: 'lunch_start', type: 'time', nullable: true })
  lunchStart: string | null;

  @Column({ name: 'lunch_end', type: 'time', nullable: true })
  lunchEnd: string | null;

  @Column({ name: 'slot_minutes', type: 'int', default: 30 })
  slotMinutes: number;

  @Column({ name: 'slot_capacity', type: 'int', default: 2 })
  slotCapacity: number;
}
