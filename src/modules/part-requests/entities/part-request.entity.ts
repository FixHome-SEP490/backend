// src/modules/part-requests/entities/part-request.entity.ts
import { Entity, Column, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import {
  PartRequestStatus,
  PartRequestType,
  FulfillmentMethod,
} from '../../../shared/enums';
import { PartRequestItem } from './part-request-item.entity';

@Entity('part_requests')
@Index('ix_part_requests_service_order', ['serviceOrderId'])
@Index('ix_part_requests_technician', ['technicianId'])
@Index('ix_part_requests_status', ['status'])
export class PartRequest extends BaseEntity {
  @Column({ name: 'service_order_id', type: 'uuid' })
  serviceOrderId: string;

  @Column({ name: 'technician_id', type: 'uuid' })
  technicianId: string;

  @Column({
    name: 'request_type',
    type: 'enum',
    enum: PartRequestType,
  })
  requestType: PartRequestType;

  @Column({
    name: 'fulfillment_method',
    type: 'enum',
    enum: FulfillmentMethod,
    default: FulfillmentMethod.PICKUP,
  })
  fulfillmentMethod: FulfillmentMethod;

  @Column({
    type: 'enum',
    enum: PartRequestStatus,
    default: PartRequestStatus.REQUESTED,
  })
  status: PartRequestStatus;

  @Column({ type: 'text', nullable: true })
  reason?: string | null;

  @Column({ name: 'shipping_fee', type: 'bigint', default: 0 })
  shippingFee: number;

  // Link to additional_cost_requests if this part request was created from an approved additional cost
  @Column({ name: 'additional_cost_id', type: 'uuid', nullable: true })
  additionalCostId?: string | null;

  @Column({ name: 'quotation_id', type: 'uuid', nullable: true })
  quotationId?: string | null;

  // Set only on a warranty request; the claim it serves.
  @Column({ name: 'warranty_claim_id', type: 'uuid', nullable: true })
  warrantyClaimId?: string | null;

  // Warranty request caused by the technician's own workmanship: the technician pays the part.
  @Column({ name: 'charge_technician', type: 'boolean', default: false })
  chargeTechnician: boolean;

  // Warranty only: what the manager found on the faulty part brought back to the warehouse.
  @Column({ name: 'faulty_inspection_result', type: 'varchar', length: 16, nullable: true })
  faultyInspectionResult?: 'manufacturer' | 'installation' | 'undetermined' | null;

  @Column({ name: 'faulty_inspection_note', type: 'text', nullable: true })
  faultyInspectionNote?: string | null;

  @Column({ name: 'faulty_inspection_evidence', type: 'jsonb', nullable: true })
  faultyInspectionEvidence?: string[] | null;

  @Column({ name: 'faulty_inspected_at', type: 'timestamptz', nullable: true })
  faultyInspectedAt?: Date | null;

  @Column({ name: 'faulty_inspected_by', type: 'uuid', nullable: true })
  faultyInspectedBy?: string | null;

  // Warranty only: the faulty part is brought back after the replacement was received (PO 05/11/2026).
  @Column({ name: 'faulty_return_due_at', type: 'timestamptz', nullable: true })
  faultyReturnDueAt?: Date | null;

  @Column({ name: 'faulty_returned_at', type: 'timestamptz', nullable: true })
  faultyReturnedAt?: Date | null;

  @Column({ name: 'faulty_return_note', type: 'text', nullable: true })
  faultyReturnNote?: string | null;

  @Column({ name: 'faulty_return_evidence', type: 'jsonb', nullable: true })
  faultyReturnEvidence?: string[] | null;

  @Column({ name: 'faulty_return_reminded_at', type: 'timestamptz', nullable: true })
  faultyReturnRemindedAt?: Date | null;

  /** Set once the technician's wallet was debited for this part (overdue return or installation fault). */
  @Column({ name: 'faulty_return_charged_at', type: 'timestamptz', nullable: true })
  faultyReturnChargedAt?: Date | null;

  // QR handover token — generated when SM marks READY
  @Column({ name: 'qr_token', type: 'varchar', length: 128, nullable: true })
  qrToken?: string | null;

  @Column({ name: 'qr_generated_at', type: 'timestamptz', nullable: true })
  qrGeneratedAt?: Date | null;

  @Column({ name: 'received_at', type: 'timestamptz', nullable: true })
  receivedAt?: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt?: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt?: Date | null;

  @Column({ name: 'prepared_by_user_id', type: 'uuid', nullable: true })
  preparedByUserId?: string | null;

  @OneToMany(() => PartRequestItem, (item) => item.partRequest)
  items: PartRequestItem[];
}
