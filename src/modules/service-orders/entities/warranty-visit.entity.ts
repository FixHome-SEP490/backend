// src/modules/service-orders/entities/warranty-visit.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { WarrantyInspectionResult, WarrantyVisitStatus } from '../../../shared/enums';
import { WarrantyClaim } from './warranty-claim.entity';

@Entity('warranty_visits')
@Index('idx_warranty_visits_claim_status', ['warrantyClaimId', 'status'])
export class WarrantyVisit extends BaseEntity {
  @Column({ name: 'warranty_claim_id', type: 'uuid' })
  warrantyClaimId: string;

  @ManyToOne(() => WarrantyClaim, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'warranty_claim_id' })
  warrantyClaim: WarrantyClaim;

  @Column({ name: 'technician_id', type: 'uuid' })
  technicianId: string;

  @Column({
    type: 'enum',
    enum: WarrantyVisitStatus,
    enumName: 'warranty_visit_status_enum',
    default: WarrantyVisitStatus.SCHEDULED,
  })
  status: WarrantyVisitStatus;

  @Column({ name: 'scheduled_at', type: 'timestamptz', nullable: true })
  scheduledAt: Date | null;

  @Column({ name: 'checked_in_at', type: 'timestamptz', nullable: true })
  checkedInAt: Date | null;

  @Column({ name: 'check_in_lat', type: 'decimal', precision: 10, scale: 7, nullable: true })
  checkInLat: string | null;

  @Column({ name: 'check_in_lng', type: 'decimal', precision: 10, scale: 7, nullable: true })
  checkInLng: string | null;

  @Column({
    name: 'proposed_result',
    type: 'enum',
    enum: WarrantyInspectionResult,
    enumName: 'warranty_inspection_result_enum',
    nullable: true,
  })
  proposedResult: WarrantyInspectionResult | null;

  @Column({ name: 'not_covered_reason_code', type: 'varchar', length: 40, nullable: true })
  notCoveredReasonCode: string | null;

  @Column({ type: 'text', nullable: true })
  findings: string | null;

  @Column({ name: 'evidence_refs', type: 'jsonb', nullable: true })
  evidenceRefs: string[] | null;

  @Column({ name: 're_service_notes', type: 'text', nullable: true })
  reServiceNotes: string | null;

  @Column({ name: 're_service_evidence_refs', type: 'jsonb', nullable: true })
  reServiceEvidenceRefs: string[] | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
