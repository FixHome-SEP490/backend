import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { SupportCaseStatus, SupportCaseType } from '../../../shared/enums';
import {
  SUPPORT_CASE_MAX_DESCRIPTION_LENGTH,
  SUPPORT_CASE_MAX_REASON_LENGTH,
  SUPPORT_CASE_MAX_RESOLUTION_CODE_LENGTH,
  SUPPORT_CASE_MAX_RESOLUTION_REASON_LENGTH,
} from '../support-case.constants';

@Entity('support_cases')
@Index('idx_support_cases_status_created_at', ['status', 'createdAt'])
@Index('idx_support_cases_case_type_created_at', ['caseType', 'createdAt'])
@Index('idx_support_cases_service_order_id', ['serviceOrderId'])
@Index('idx_support_cases_booking_id', ['bookingId'])
@Index('idx_support_cases_assigned_manager_id', ['assignedManagerId'])
export class SupportCase extends BaseEntity {
  @Column({
    name: 'case_type',
    type: 'enum',
    enum: SupportCaseType,
    enumName: 'support_case_type_enum',
  })
  caseType: SupportCaseType;

  @Column({
    type: 'enum',
    enum: SupportCaseStatus,
    enumName: 'support_case_status_enum',
    default: SupportCaseStatus.OPEN,
  })
  status: SupportCaseStatus;

  @Column({ name: 'booking_id', type: 'uuid', nullable: true })
  bookingId: string | null;

  @Column({ name: 'service_order_id', type: 'uuid', nullable: true })
  serviceOrderId: string | null;

  @Column({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId: string | null;

  @Column({ name: 'technician_id', type: 'uuid', nullable: true })
  technicianId: string | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ name: 'assigned_manager_id', type: 'uuid', nullable: true })
  assignedManagerId: string | null;

  @Column({
    type: 'varchar',
    length: SUPPORT_CASE_MAX_REASON_LENGTH,
  })
  reason: string;

  @Column({
    type: 'varchar',
    length: SUPPORT_CASE_MAX_DESCRIPTION_LENGTH,
    nullable: true,
  })
  description: string | null;

  @Column({
    name: 'resolution_code',
    type: 'varchar',
    length: SUPPORT_CASE_MAX_RESOLUTION_CODE_LENGTH,
    nullable: true,
  })
  resolutionCode: string | null;

  @Column({
    name: 'resolution_reason',
    type: 'varchar',
    length: SUPPORT_CASE_MAX_RESOLUTION_REASON_LENGTH,
    nullable: true,
  })
  resolutionReason: string | null;

  @Column({ name: 'evidence_refs', type: 'jsonb', nullable: true })
  evidenceRefs: string[] | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;
}
