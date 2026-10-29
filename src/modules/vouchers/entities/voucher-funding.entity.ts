import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { bigintTransformer } from '../../wallet/entities/wallet.entity';
import type { VoucherInvoiceFundingAllocation } from '../voucher-funding-allocation';

export type VoucherFundingRail = 'WALLET' | 'VNPAY' | 'CASH' | 'ZERO';
export type VoucherFundingScopeKind = 'SOLO' | 'VISIT_GROUP';
export type VoucherFundingEntryKind =
  | 'PROVIDER_PENDING' | 'PROVIDER_PAID' | 'PROVIDER_FAILED' | 'QUARANTINED'
  | 'SUBSIDY_COMMITTED' | 'CASH_TECH_CREDIT' | 'CUSTOMER_REFUND'
  | 'SUBSIDY_REVERSAL' | 'QUOTA_RESTORED';

/** One immutable reservation-to-payment binding, created before collection. */
@Entity('voucher_payment_links')
@Index('idx_voucher_links_customer_scope', ['customerId', 'scopeId'])
export class VoucherPaymentLink {
  @PrimaryGeneratedColumn('uuid') id: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @Column({ name: 'reservation_id', type: 'uuid', unique: true }) reservationId: string;
  @Column({ name: 'attempt_id', type: 'uuid' }) attemptId: string;
  @Column({ name: 'customer_id', type: 'uuid' }) customerId: string;
  @Column({ name: 'scope_id', type: 'uuid' }) scopeId: string;
  @Column({ name: 'scope_kind', type: 'varchar', length: 16 }) scopeKind: VoucherFundingScopeKind;
  @Column({ type: 'varchar', length: 8 }) rail: VoucherFundingRail;
  @Column({ name: 'payment_id', type: 'uuid', nullable: true, unique: true }) paymentId: string | null;
  @Column({ name: 'cash_settlement_id', type: 'uuid', nullable: true, unique: true }) cashSettlementId: string | null;
  @Column({ name: 'visit_group_payment_id', type: 'uuid', nullable: true, unique: true }) visitGroupPaymentId: string | null;
  @Column({ name: 'provider_txn_ref', type: 'varchar', length: 128, nullable: true, unique: true }) providerTxnRef: string | null;
  @Column({ name: 'provider_initiated_at', type: 'timestamptz', nullable: true }) providerInitiatedAt: Date | null;
  @Column({ name: 'original_gross_vnd', type: 'bigint', transformer: bigintTransformer }) originalGrossVnd: number;
  @Column({ name: 'eligible_base_vnd', type: 'bigint', transformer: bigintTransformer }) eligibleBaseVnd: number;
  @Column({ name: 'subsidy_vnd', type: 'bigint', transformer: bigintTransformer }) subsidyVnd: number;
  @Column({ name: 'customer_due_vnd', type: 'bigint', transformer: bigintTransformer }) customerDueVnd: number;
  @Column({ name: 'allocation_snapshot', type: 'jsonb' }) allocationSnapshot: VoucherInvoiceFundingAllocation[];
  @Column({ name: 'allocation_sha256', type: 'char', length: 64 }) allocationSha256: string;
}

/** Append-only company funding and provider/refund evidence. */
@Entity('voucher_funding_entries')
@Index('idx_voucher_entries_refund_source', ['refundSourceId'], { where: 'refund_source_id IS NOT NULL' })
export class VoucherFundingEntry {
  @PrimaryGeneratedColumn('uuid') id: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @Column({ name: 'link_id', type: 'uuid' }) linkId: string;
  @Column({ name: 'invoice_id', type: 'uuid', nullable: true }) invoiceId: string | null;
  @Column({ type: 'varchar', length: 32 }) kind: VoucherFundingEntryKind;
  @Column({ name: 'amount_vnd', type: 'bigint', transformer: bigintTransformer }) amountVnd: number;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 160, unique: true }) idempotencyKey: string;
  @Column({ name: 'provider_reference', type: 'varchar', length: 255, nullable: true }) providerReference: string | null;
  @Column({ name: 'provider_paid_at', type: 'timestamptz', nullable: true }) providerPaidAt: Date | null;
  @Column({ name: 'evidence_sha256', type: 'char', length: 64, nullable: true }) evidenceSha256: string | null;
  @Column({ name: 'wallet_transaction_id', type: 'uuid', nullable: true }) walletTransactionId: string | null;
  @Column({ name: 'customer_wallet_transaction_id', type: 'uuid', nullable: true }) customerWalletTransactionId: string | null;
  @Column({ name: 'refund_source_id', type: 'uuid', nullable: true }) refundSourceId: string | null;
}
