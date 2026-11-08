import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';

export enum WarehouseStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

@Entity('warehouses')
@Index('ix_warehouses_responsible_user', ['responsibleUserId'])
export class Warehouse extends BaseEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  address: string | null;

  /** Optional verified or demo-approximate coordinates (WGS84). */
  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude: number | null;

  @Column({ type: 'enum', enum: WarehouseStatus, enumName: 'warehouse_status', default: WarehouseStatus.ACTIVE })
  status: WarehouseStatus;

  @Column({ name: 'responsible_user_id', type: 'uuid' })
  responsibleUserId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'responsible_user_id' })
  responsibleUser: User;
}
