// src/modules/service-orders/entities/additional-cost-item.entity.ts
// Spec v1.4 BRX-052: Every PARTS_EQUIPMENT item must snapshot partSource
import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { CostItemType, PartSource, PartWarrantyOption } from '../../../shared/enums';
import { AdditionalCostRequest } from './additional-cost-request.entity';

@Entity('additional_cost_items')
export class AdditionalCostItem extends BaseEntity {
  @Column({ name: 'request_id', type: 'uuid' })
  requestId: string;

  @ManyToOne(() => AdditionalCostRequest, (r) => r.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request: AdditionalCostRequest;

  @Column({ type: 'enum', enum: CostItemType })
  type: CostItemType;

  @Column({ type: 'varchar' })
  description: string;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column({ name: 'unit_price', type: 'bigint', default: 0 })
  unitPrice: number;

  @Column({ name: 'line_total', type: 'bigint', default: 0 })
  lineTotal: number;

  @Column({ name: 'warranty_days', type: 'int', default: 0 })
  warrantyDays: number;

  // ── Spec v1.4 BRX-052: Part Source fields (required for PARTS_EQUIPMENT) ──

  @Column({
    name: 'part_source',
    type: 'enum',
    enum: PartSource,
    nullable: true,
  })
  partSource?: PartSource | null;

  @Column({ name: 'part_catalog_id', type: 'uuid', nullable: true })
  partCatalogId?: string | null;

  @Column({ name: 'part_name_snapshot', type: 'varchar', nullable: true })
  partNameSnapshot?: string | null;

  @Column({
    name: 'part_warranty_option',
    type: 'enum',
    enum: PartWarrantyOption,
    nullable: true,
  })
  partWarrantyOption?: PartWarrantyOption | null;

  @Column({ name: 'warranty_fee', type: 'bigint', nullable: true })
  warrantyFee?: number | null;

  @Column({ name: 'warranty_term_days', type: 'int', nullable: true })
  warrantyTermDays?: number | null;
}

