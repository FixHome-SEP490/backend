// src/modules/services/entities/part-catalog.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { Service } from './service.entity';

@Entity('part_catalog')
@Index('idx_part_catalog_code', ['code'], { unique: true })
@Index('idx_part_catalog_service_id', ['serviceId'])
export class PartCatalog extends BaseEntity {
  @Column({ type: 'varchar', length: 50, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ name: 'service_id', type: 'uuid', nullable: true })
  serviceId?: string | null;

  @ManyToOne(() => Service, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'service_id' })
  service?: Service | null;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  price: number;

  @Column({ name: 'warranty_days', type: 'int', default: 90 })
  warrantyDays: number;

  @Column({
    name: 'warranty_policy',
    type: 'varchar',
    length: 255,
    default: 'Bảo hành chính hãng FixHome',
  })
  warrantyPolicy: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
