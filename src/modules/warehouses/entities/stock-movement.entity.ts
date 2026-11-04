import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { FixHomePart } from '../../parts-catalog/entities/fixhome-part.entity';
import { User } from '../../users/entities/user.entity';
import { Warehouse } from './warehouse.entity';

export enum StockMovementKind {
  STOCK_IN = 'stock_in',
  CORRECTION = 'correction',
}

@Entity('stock_movements')
@Index('uq_stock_movements_idempotency', ['idempotencyKey'], { unique: true })
@Index('ix_stock_movements_warehouse_created', ['warehouseId', 'createdAt'])
@Index('ix_stock_movements_part_created', ['partId', 'createdAt'])
export class StockMovement extends BaseEntity {
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

  @Column({ name: 'actor_user_id', type: 'uuid' })
  actorUserId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actor: User;

  @Column({ type: 'enum', enum: StockMovementKind, enumName: 'stock_movement_kind' })
  kind: StockMovementKind;

  @Column({ name: 'delta', type: 'integer' })
  delta: number;

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint: string;

  @Column({ name: 'on_hand_after', type: 'integer' })
  onHandAfter: number;

  @Column({ name: 'reserved_after', type: 'integer' })
  reservedAfter: number;
}
