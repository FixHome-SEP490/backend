import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type {
  DeliveryPhysicalState,
  PhysicalCommandKind,
} from '../warehouse-delivery.policy';

@Entity('warehouse_delivery_events')
export class WarehouseDeliveryEvent {
  @PrimaryColumn({ name: 'part_request_id', type: 'uuid' })
  partRequestId: string;
  @PrimaryColumn({ name: 'command_id', type: 'uuid' }) commandId: string;
  @Column({ name: 'actor_user_id', type: 'uuid' }) actorUserId: string;
  @Column({ name: 'actor_role', type: 'varchar', length: 32 })
  actorRole: string;
  @Column({ type: 'varchar', length: 32 }) kind: PhysicalCommandKind;
  @Column({ name: 'expected_version', type: 'integer' })
  expectedVersion: number;
  @Column({ name: 'result_version', type: 'integer' }) resultVersion: number;
  @Column({ type: 'char', length: 64 }) fingerprint: string;
  @Column({ type: 'jsonb' }) snapshot: DeliveryPhysicalState;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
