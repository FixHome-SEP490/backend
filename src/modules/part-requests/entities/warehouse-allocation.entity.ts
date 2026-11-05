import { Column, Entity, PrimaryColumn } from 'typeorm';

export type WarehouseAllocationStatus = 'manual_assistance' | 'reserved' | 'ready' | 'handed_over' | 'received' | 'released';

@Entity('part_request_warehouse_allocations')
export class WarehouseAllocation {
  @PrimaryColumn({ name: 'part_request_id', type: 'uuid' }) partRequestId: string;
  @Column({ name: 'warehouse_id', type: 'uuid', nullable: true }) warehouseId: string | null;
  @Column({ name: 'responsible_user_id', type: 'uuid', nullable: true }) responsibleUserId: string | null;
  @Column({ name: 'technician_id', type: 'uuid' }) technicianId: string;
  @Column({ type: 'varchar', length: 24 }) status: WarehouseAllocationStatus;
  @Column({ name: 'token_hash', type: 'char', length: 64, nullable: true, select: false }) tokenHash: string | null;
  @Column({ name: 'token_expires_at', type: 'timestamptz', nullable: true }) tokenExpiresAt: Date | null;
  @Column({ name: 'token_version', type: 'integer', default: 0 }) tokenVersion: number;
  @Column({ name: 'receipt_hash', type: 'char', length: 64, nullable: true, select: false }) receiptHash: string | null;
  @Column({ name: 'receipt_expires_at', type: 'timestamptz', nullable: true }) receiptExpiresAt: Date | null;
  @Column({ name: 'handed_over_at', type: 'timestamptz', nullable: true }) handedOverAt: Date | null;
  @Column({ name: 'handed_over_by', type: 'uuid', nullable: true }) handedOverBy: string | null;
  @Column({ name: 'received_at', type: 'timestamptz', nullable: true }) receivedAt: Date | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
