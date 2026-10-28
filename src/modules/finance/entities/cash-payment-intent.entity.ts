import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { CashIntentAllocation } from '../cash-intent-policy';

export type CashIntentScope = 'SOLO' | 'VISIT_GROUP';
export type CashIntentStatus = 'pending' | 'cancelled' | 'received';
const vnd = { to: (value: number | null) => value,
  from: (value: string | null) => value === null ? null : Number(value) };

@Entity('cash_payment_intents')
@Index('uq_cash_intent_customer_command', ['customerId', 'commandId'], { unique: true })
export class CashPaymentIntent extends BaseEntity {
  @Column({ name: 'scope_kind', type: 'varchar', length: 16 })
  scopeKind: CashIntentScope;

  @Column({ name: 'scope_id', type: 'uuid' })
  scopeId: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ name: 'technician_id', type: 'uuid' })
  technicianId: string;

  @Column({ type: 'varchar', length: 16 })
  status: CashIntentStatus;

  @Column({ name: 'gross_vnd', type: 'bigint', transformer: vnd })
  grossVnd: number;

  @Column({ name: 'customer_due_vnd', type: 'bigint', transformer: vnd })
  customerDueVnd: number;

  @Column({ name: 'allocation_snapshot', type: 'jsonb' })
  allocations: CashIntentAllocation[];

  @Column({ name: 'voucher_reservation_id', type: 'uuid', nullable: true })
  voucherReservationId: string | null;

  @Column({ name: 'command_id', type: 'uuid' })
  commandId: string;

  @Column({ name: 'receipt_command_id', type: 'uuid', nullable: true })
  receiptCommandId: string | null;

  @Column({ name: 'cancel_command_id', type: 'uuid', nullable: true })
  cancelCommandId: string | null;

  @Column({ name: 'received_amount_vnd', type: 'bigint', nullable: true, transformer: vnd })
  receivedAmountVnd: number | null;

  @Column({ name: 'receipt_evidence_url', type: 'text', nullable: true })
  receiptEvidenceUrl: string | null;

  @Column({ name: 'received_at', type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  @Column({ name: 'cash_settlement_id', type: 'uuid', nullable: true })
  cashSettlementId: string | null;

  @Column({ name: 'visit_group_payment_id', type: 'uuid', nullable: true })
  visitGroupPaymentId: string | null;
}
