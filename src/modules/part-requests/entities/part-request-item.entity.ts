// src/modules/part-requests/entities/part-request-item.entity.ts
import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { PartSource, PartUsageStatus } from '../../../shared/enums';
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
}
