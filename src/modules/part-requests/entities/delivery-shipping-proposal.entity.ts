import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** Shipping-only authority; no payable, tax or payment authority. */
@Entity('delivery_shipping_proposals')
export class DeliveryShippingProposal {
  @PrimaryColumn({ name: 'part_request_id', type: 'uuid' })
  partRequestId: string;
  @PrimaryColumn({ name: 'quote_version', type: 'integer' })
  quoteVersion: number;
  @Column({ name: 'command_id', type: 'uuid' }) commandId: string;
  @Column({ name: 'warehouse_id', type: 'uuid' }) warehouseId: string;
  @Column({ name: 'responsible_user_id', type: 'uuid' })
  responsibleUserId: string;
  @Column({ name: 'assignment_id', type: 'uuid' }) assignmentId: string;
  @Column({ name: 'context_digest', type: 'char', length: 64 })
  contextDigest: string;
  @Column({ name: 'courier_reference', type: 'varchar', length: 256 })
  courierReference: string;
  @Column({ name: 'evidence_id', type: 'uuid' }) evidenceId: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
