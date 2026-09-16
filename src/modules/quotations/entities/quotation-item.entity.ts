// src/modules/quotations/entities/quotation-item.entity.ts
// Spec v1.4 BRX-052: Every PARTS_EQUIPMENT item must snapshot partSource
import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { CostItemType, PartSource, PartWarrantyOption } from '../../../shared/enums';
import { Quotation } from './quotation.entity';

@Entity('quotation_items')
export class QuotationItem extends BaseEntity {
  @Column({ name: 'quotation_id', type: 'uuid' })
  quotationId: string;

  @ManyToOne(() => Quotation, (q) => q.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'quotation_id' })
  quotation: Quotation;

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

  @Column({ name: 'warranty_days_snapshot', type: 'int', default: 0 })
  warrantyDaysSnapshot: number;

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

  // Spec v1.4 D-14: warranty option snapshot
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

