import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { DeliveryConsentState } from '../delivery-consent.policy';

export type DeliveryConsentProjection = Omit<DeliveryConsentState, 'receipts'>;

/** Inert B1 storage. This identity is a historical snapshot, never dispatch authority. */
@Entity('delivery_consent_sessions')
export class DeliveryConsentSession {
  @PrimaryColumn({ name: 'part_request_id', type: 'uuid' })
  partRequestId: string;
  @Column({ name: 'service_order_id', type: 'uuid' }) serviceOrderId: string;
  @Column({ name: 'customer_user_id', type: 'uuid' }) customerId: string;
  @Column({ name: 'technician_user_id', type: 'uuid' }) technicianId: string;
  @Column({ name: 'active_assignment_id', type: 'uuid' }) assignmentId: string;
  @Column({ name: 'responsible_service_manager_id', type: 'uuid' })
  responsibleServiceManagerId: string;
  @Column({ name: 'warehouse_id', type: 'uuid', nullable: true }) warehouseId:
    string | null;
  @Column({ name: 'source_quotation_id', type: 'uuid', nullable: true })
  sourceQuotationId: string | null;
  @Column({ name: 'source_additional_cost_id', type: 'uuid', nullable: true })
  sourceAdditionalCostId: string | null;
  @Column({ type: 'integer' }) version: number;
  @Column({ name: 'quote_version', type: 'integer' }) quoteVersion: number;
  @Column({ type: 'varchar', length: 32 })
  status: DeliveryConsentState['status'];
  @Column({ type: 'jsonb' }) projection: DeliveryConsentProjection;
  @Column({ name: 'invalidated_at', type: 'timestamptz', nullable: true })
  invalidatedAt: Date | null;
  @Column({
    name: 'invalidation_reason',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  invalidationReason: 'SCOPE_CHANGED' | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
