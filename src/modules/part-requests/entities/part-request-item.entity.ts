// src/modules/part-requests/entities/part-request-item.entity.ts
import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { FaultyPartStatus, PartSource, PartUsageStatus } from '../../../shared/enums';
import { PartRequest } from './part-request.entity';

@Entity('part_request_items')
export class PartRequestItem extends BaseEntity {
  @Column({ name: 'part_request_id', type: 'uuid' })
  partRequestId: string;

  @ManyToOne(() => PartRequest, (r) => r.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'part_request_id' })
  partRequest: PartRequest;

  // Nullable — null for EXTERNAL parts
  @Column({ name: 'part_catalog_id', type: 'uuid', nullable: true })
  partCatalogId?: string | null;

  @Column({
    name: 'part_source',
    type: 'enum',
    enum: PartSource,
    default: PartSource.FIXHOME,
  })
  partSource: PartSource;

  @Column({ name: 'part_name_snapshot', type: 'varchar', length: 255 })
  partNameSnapshot: string;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column({ name: 'unit_price_snapshot', type: 'bigint', default: 0 })
  unitPriceSnapshot: number;

  @Column({
    name: 'usage_status',
    type: 'enum',
    enum: PartUsageStatus,
    default: PartUsageStatus.PENDING,
  })
  usageStatus: PartUsageStatus;

  @Column({ type: 'text', nullable: true })
  note?: string | null;

  // Warranty requests only: the faulty units of this line, counted in by the manager.
  @Column({ name: 'faulty_status', type: 'varchar', length: 30, nullable: true })
  faultyStatus?: FaultyPartStatus | null;

  @Column({ name: 'faulty_received_qty', type: 'int', default: 0 })
  faultyReceivedQty: number;

  @Column({ name: 'faulty_received_at', type: 'timestamptz', nullable: true })
  faultyReceivedAt?: Date | null;

  @Column({ name: 'faulty_sent_at', type: 'timestamptz', nullable: true })
  faultySentAt?: Date | null;

  @Column({ name: 'faulty_result_note', type: 'text', nullable: true })
  faultyResultNote?: string | null;

  @Column({ name: 'faulty_result_evidence', type: 'jsonb', nullable: true })
  faultyResultEvidence?: string[] | null;

  @Column({ name: 'faulty_resolved_at', type: 'timestamptz', nullable: true })
  faultyResolvedAt?: Date | null;

  @Column({ name: 'faulty_resolved_by', type: 'uuid', nullable: true })
  faultyResolvedBy?: string | null;
}
