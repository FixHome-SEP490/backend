// src/modules/parts-catalog/entities/fixhome-part.entity.ts
import { Entity, Column, Index, Check } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

@Entity('fixhome_parts')
@Index('idx_fixhome_parts_sku', ['sku'], { unique: true })
@Index('idx_fixhome_parts_is_active', ['isActive'])
@Check('chk_fixhome_parts_selling_price', '"selling_price" >= 0')
@Check(
  'chk_fixhome_parts_warranty_days',
  '"warranty_days" IS NULL OR ("warranty_days" >= 0 AND "warranty_days" <= 3650)',
)
export class FixHomePart extends BaseEntity {
  @Column({ name: 'sku', type: 'varchar', length: 100, nullable: true })
  sku: string | null;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description: string | null;

  @Column({
    name: 'selling_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: {
      to: (value: number) => value,
      from: (value: string | number) => Number(value),
    },
  })
  sellingPrice: number;

  @Column({ name: 'warranty_days', type: 'int', nullable: true })
  warrantyDays: number | null;

  @Column({ name: 'warranty_policy', type: 'text', nullable: true })
  warrantyPolicy: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
