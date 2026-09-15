// src/modules/service-orders/entities/customer-service-confirmation.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { ServiceOrder } from './service-order.entity';
import { User } from '../../users/entities/user.entity';

@Entity('customer_service_confirmations')
@Unique('uq_confirmation_order', ['serviceOrderId'])
@Index('idx_confirmation_customer', ['customerId'])
export class CustomerServiceConfirmation extends BaseEntity {
  @Column({ name: 'service_order_id', type: 'uuid' })
  serviceOrderId: string;

  @ManyToOne(() => ServiceOrder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'service_order_id' })
  serviceOrder: ServiceOrder;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column({ name: 'confirmed_at', type: 'timestamptz', default: () => 'now()' })
  confirmedAt: Date;

  @Column({ type: 'text', nullable: true })
  feedback?: string | null;

  @Column({ type: 'int', nullable: true })
  rating?: number | null;

  @Column({ name: 'signature_url', type: 'varchar', nullable: true })
  signatureUrl?: string | null;
}
