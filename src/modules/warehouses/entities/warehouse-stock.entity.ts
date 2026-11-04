import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { FixHomePart } from '../../parts-catalog/entities/fixhome-part.entity';
import { Warehouse } from './warehouse.entity';

@Entity('warehouse_stock')
@Index('uq_warehouse_stock_warehouse_part', ['warehouseId', 'partId'], { unique: true })
@Check('chk_warehouse_stock_balance', '"on_hand" >= "reserved" AND "reserved" >= 0')
@Check('chk_warehouse_stock_version', '"version" >= 0')
export class WarehouseStock extends BaseEntity {
  @Column({ name: 'warehouse_id', type: 'uuid' })
  warehouseId: string;

  @ManyToOne(() => Warehouse, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'warehouse_id' })
  warehouse: Warehouse;

  @Column({ name: 'part_id', type: 'uuid' })
  partId: string;

  @ManyToOne(() => FixHomePart, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'part_id' })
  part: FixHomePart;

  @Column({ name: 'on_hand', type: 'integer', default: 0 })
  onHand: number;

  @Column({ type: 'integer', default: 0 })
  reserved: number;

  @Column({ type: 'integer', default: 0 })
  version: number;
}
