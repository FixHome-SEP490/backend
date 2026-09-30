// src/modules/service-orders/entities/warranty-claim.entity.ts
import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { WarrantyClaimStatus, WarrantyCustomerPrompt } from '../../../shared/enums';
import { ServiceOrder } from './service-order.entity';
import { WarrantyCoverage } from './warranty-coverage.entity';
import { User } from '../../users/entities/user.entity';

export type WarrantyCustomerResponse = 'agreed' | 'disputed';

@Entity('warranty_claims')
export class WarrantyClaim extends BaseEntity {
  @Column({ name: 'service_order_id', type: 'uuid' })
  serviceOrderId: string;

  @ManyToOne(() => ServiceOrder, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'service_order_id' })
  serviceOrder: ServiceOrder;

  @Column({ name: 'warranty_coverage_id', type: 'uuid' })
  warrantyCoverageId: string;

  @ManyToOne(() => WarrantyCoverage, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'warranty_coverage_id' })
  warrantyCoverage: WarrantyCoverage;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column({ name: 'technician_id', type: 'uuid', nullable: true })
  technicianId: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'technician_id' })
  technician: User | null;

  @Column({ type: 'text' })
  description: string;

  @Column({ name: 'evidence_refs', type: 'jsonb', nullable: true })
  evidenceRefs: string[] | null;

  @Column({
    type: 'enum',
    enum: WarrantyClaimStatus,
    enumName: 'warranty_claim_status_enum',
    default: WarrantyClaimStatus.SUBMITTED,
  })
  status: WarrantyClaimStatus;

  @Column({ name: 'submitted_after_expiry', type: 'boolean', default: false })
  submittedAfterExpiry: boolean;

  @Column({ name: 'customer_response', type: 'varchar', length: 16, nullable: true })
  customerResponse: WarrantyCustomerResponse | null;

  @Column({ name: 'customer_responded_at', type: 'timestamptz', nullable: true })
  customerRespondedAt: Date | null;

  @Column({ name: 'escalated_support_case_id', type: 'uuid', nullable: true })
  escalatedSupportCaseId: string | null;

  @Column({ name: 'awaiting_prompt', type: 'varchar', length: 16, nullable: true })
  awaitingPrompt: WarrantyCustomerPrompt | null;

  @Column({ name: 'declined_by_technician_id', type: 'uuid', nullable: true })
  declinedByTechnicianId: string | null;

  @Column({ name: 'decline_reason_code', type: 'varchar', length: 32, nullable: true })
  declineReasonCode: string | null;

  @Column({ name: 'decline_note', type: 'text', nullable: true })
  declineNote: string | null;

  @Column({ name: 'declined_at', type: 'timestamptz', nullable: true })
  declinedAt: Date | null;

  @Column({ name: 'final_result', type: 'varchar', length: 32, nullable: true })
  finalResult: string | null;

  @Column({ name: 'final_reason_code', type: 'varchar', length: 40, nullable: true })
  finalReasonCode: string | null;

  @Column({ name: 'sm_overrode_proposal', type: 'boolean', default: false })
  smOverrodeProposal: boolean;

  @Column({ name: 'reviewed_by_manager_id', type: 'uuid', nullable: true })
  reviewedByManagerId: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', default: () => 'now()' })
  submittedAt: Date;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt?: Date | null;

  @Column({ name: 'resolution_notes', type: 'text', nullable: true })
  resolutionNotes?: string | null;
}
