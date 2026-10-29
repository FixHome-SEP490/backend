import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { VoucherFundingEntry, VoucherPaymentLink } from './voucher-funding.entity';
import {
  CheckoutFacts,
  ReservationState,
  VoucherKind,
  VoucherCampaignState,
  VoucherPolicy,
  VoucherSourceKind,
} from '../voucher.types';

@Entity('voucher_campaigns')
@Index('uq_voucher_campaign_code', ['code'], { unique: true })
@Index('uq_voucher_campaign_kind', ['id', 'kind'], { unique: true })
export class VoucherCampaign extends BaseEntity {
  @Column({ type: 'varchar', length: 40 }) code: string;
  @Column({ type: 'varchar', length: 120 }) name: string;
  @Column({ type: 'varchar', length: 16 }) kind: VoucherKind;
  @Column({ type: 'jsonb' }) policy: VoucherPolicy;
  @Column({ name: 'starts_at', type: 'timestamptz' }) startsAt: Date;
  @Column({ name: 'ends_at', type: 'timestamptz' }) endsAt: Date;
  @Column({ type: 'boolean', default: false }) active: boolean;
  @Column({ type: 'varchar', length: 16, default: VoucherCampaignState.DRAFT }) status: VoucherCampaignState;
  @Column({ type: 'int', default: 1 }) version: number;
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true }) publishedAt: Date | null;
  @Column({ name: 'auto_compensation', type: 'boolean', default: false }) autoCompensation: boolean;
  @Column({ type: 'int' }) quota: number;
  @Column({ type: 'int', default: 0 }) redeemed: number;
}

@Entity('voucher_claims')
@Index('uq_voucher_claim_customer', ['campaignId', 'customerId'], {
  unique: true,
  where: 'source_key IS NULL',
})
@Index('uq_voucher_compensation_source', ['sourceKind', 'sourceId'], {
  unique: true,
  where: 'source_id IS NOT NULL',
})
@Index('uq_voucher_claim_identity', ['id', 'campaignId', 'customerId'], {
  unique: true,
})
@Index('idx_voucher_wallet', ['customerId', 'createdAt'])
export class VoucherClaim extends BaseEntity {
  @Column({ name: 'campaign_id', type: 'uuid' }) campaignId: string;
  @Column({ name: 'campaign_kind', type: 'varchar', length: 16 })
  campaignKind: VoucherKind;
  @Column({ name: 'customer_id', type: 'uuid' }) customerId: string;
  @Column({ name: 'source_kind', type: 'varchar', length: 16, nullable: true })
  sourceKind: VoucherSourceKind | null;
  @Column({ name: 'source_id', type: 'uuid', nullable: true }) sourceId:
    string | null;
  @Column({ name: 'source_key', type: 'varchar', length: 64, nullable: true })
  sourceKey: string | null;
  @Column({ name: 'policy_snapshot', type: 'jsonb' })
  policySnapshot: VoucherPolicy;
  @Column({ name: 'redeemed_at', type: 'timestamptz', nullable: true })
  redeemedAt: Date | null;
}

@Entity('voucher_reservations')
@Index('uq_voucher_attempt', ['customerId', 'attemptId'], { unique: true })
@Index('uq_voucher_live_claim', ['claimId'], {
  unique: true,
  where: "state IN ('RESERVED', 'REDEEMED')",
})
@Index('uq_voucher_live_scope', ['scopeId'], {
  unique: true,
  where: "state IN ('RESERVED', 'REDEEMED')",
})
@Index('uq_voucher_settlement', ['settlementId'], {
  unique: true,
  where: 'settlement_id IS NOT NULL',
})
@Index('idx_voucher_reservation_expiry', ['campaignId', 'state', 'expiresAt'])
export class VoucherReservation extends BaseEntity {
  @Column({ name: 'campaign_id', type: 'uuid' }) campaignId: string;
  @Column({ name: 'claim_id', type: 'uuid' }) claimId: string;
  @Column({ name: 'customer_id', type: 'uuid' }) customerId: string;
  @Column({ name: 'scope_id', type: 'uuid' }) scopeId: string;
  @Column({ name: 'attempt_id', type: 'uuid' }) attemptId: string;
  @Column({ type: 'varchar', length: 16 }) state: ReservationState;
  @Column({ name: 'reserved_at', type: 'timestamptz' }) reservedAt: Date;
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt: Date;
  @Column({ name: 'policy_snapshot', type: 'jsonb' })
  policySnapshot: VoucherPolicy;
  @Column({ name: 'checkout_snapshot', type: 'jsonb' })
  checkoutSnapshot: CheckoutFacts;
  @Column({ name: 'settlement_id', type: 'uuid', nullable: true })
  settlementId: string | null;
}

@Entity('voucher_audit')
export class VoucherAudit extends BaseEntity {
  @Column({ name: 'actor_id', type: 'uuid', nullable: true }) actorId:
    string | null;
  @Column({ type: 'varchar', length: 32 }) action: string;
  @Column({ name: 'resource_id', type: 'uuid' }) resourceId: string;
  @Column({ type: 'jsonb' }) snapshot: Record<string, unknown>;
}

export const VOUCHER_ENTITIES = [
  VoucherCampaign,
  VoucherClaim,
  VoucherReservation,
  VoucherAudit,
  VoucherPaymentLink,
  VoucherFundingEntry,
];
