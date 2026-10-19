import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

@Entity('part_custody_payouts')
@Index('uq_custody_payout_component', ['invoiceId', 'component'], { unique: true })
export class CustodyPayout extends BaseEntity {
  @Column({ name: 'invoice_id', type: 'uuid' }) invoiceId: string;
  @Column({ name: 'service_order_id', type: 'uuid' }) serviceOrderId: string;
  @Column({ name: 'technician_id', type: 'uuid' }) technicianId: string;
  @Column({ type: 'varchar', length: 16 }) component: 'NET_LABOR' | 'NONLABOR';
  @Column({ type: 'bigint' }) amount: number;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, unique: true }) idempotencyKey: string;
}
