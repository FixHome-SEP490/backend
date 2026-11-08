import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';
import { VisitOffice } from './visit-office.entity';

export enum OfficeVisitStatus {
  SCHEDULED = 'scheduled',
  ATTENDED = 'attended',
  MISSED = 'missed',
  CANCELLED = 'cancelled',
}

/** Lượt hẹn lên trụ sở của một thợ. Mỗi thợ chỉ có một lượt `scheduled` (index một phần ở migration). */
@Entity('technician_office_visits')
@Index('idx_office_visits_office_time', ['officeId', 'scheduledAt'])
export class OfficeVisit extends BaseEntity {
  @Column({ name: 'technician_id', type: 'uuid' })
  technicianId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'technician_id' })
  technician: User;

  @Column({ name: 'office_id', type: 'uuid' })
  officeId: string;

  @ManyToOne(() => VisitOffice)
  @JoinColumn({ name: 'office_id' })
  office: VisitOffice;

  @Column({ name: 'scheduled_at', type: 'timestamptz' })
  scheduledAt: Date;

  @Column({ type: 'varchar', length: 16, default: OfficeVisitStatus.SCHEDULED })
  status: OfficeVisitStatus;

  @Column({ name: 'attended_at', type: 'timestamptz', nullable: true })
  attendedAt: Date | null;

  @Column({ name: 'attended_by', type: 'uuid', nullable: true })
  attendedById: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;
}
