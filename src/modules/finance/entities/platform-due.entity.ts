import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { PlatformDueStatus } from '../../../shared/enums';

@Entity('platform_dues')
@Unique('uq_platform_due_order', ['serviceOrderId'])
@Index('idx_platform_dues_status_created_at', ['status', 'createdAt'])
@Index('idx_platform_dues_invoice_id', ['invoiceId'])
export class PlatformDue extends BaseEntity {
  @Column({ name: 'invoice_id', type: 'uuid' })
  invoiceId: string;

  @Column({ name: 'service_order_id', type: 'uuid' })
  serviceOrderId: string;

  @Column({ name: 'labor_total_snapshot', type: 'bigint' })
  laborTotalSnapshot: number;

  @Column({ name: 'fixhome_parts_total_snapshot', type: 'bigint' })
  fixHomePartsTotalSnapshot: number;

  @Column({
    name: 'commission_rate_snapshot',
    type: 'numeric',
    precision: 5,
    scale: 4,
  })
  commissionRateSnapshot: number;

  @Column({ name: 'commission_amount_snapshot', type: 'bigint' })
  commissionAmountSnapshot: number;

  @Column({ name: 'due_amount', type: 'bigint' })
  dueAmount: number;

  @Column({
    type: 'enum',
    enum: PlatformDueStatus,
    enumName: 'platform_due_status_enum',
    default: PlatformDueStatus.PENDING,
  })
  status: PlatformDueStatus;

  @Column({ name: 'settled_at', type: 'timestamptz', nullable: true })
  settledAt?: Date | null;
}
