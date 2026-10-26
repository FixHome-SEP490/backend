import { ApiProperty } from '@nestjs/swagger';
import type {
  VoucherCampaign,
  VoucherClaim,
  VoucherReservation,
} from '../entities/voucher.entity';
import {
  ReservationState,
  VoucherDiscount,
  VoucherKind,
  VoucherPolicy,
} from '../voucher.types';

export class CustomerVoucherPolicyDto implements VoucherPolicy {
  @ApiProperty({ enum: VoucherDiscount }) discount: VoucherDiscount;
  @ApiProperty() value: number;
  @ApiProperty({ nullable: true }) capVnd: number | null;
  @ApiProperty() minimumVnd: number;
  @ApiProperty({ type: [String] }) categoryIds: string[];
  @ApiProperty({ type: [String] }) serviceIds: string[];
  @ApiProperty({ example: ['LABOR', 'PARTS'] }) components: ['LABOR', 'PARTS'];
}

export class CustomerVoucherCampaignDto {
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: VoucherKind }) kind: VoucherKind;
  @ApiProperty() startsAt: Date;
  @ApiProperty() endsAt: Date;
  @ApiProperty() active: boolean;
}
export class CustomerGeneralVoucherDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty() startsAt: Date;
  @ApiProperty() endsAt: Date;
  @ApiProperty({ type: CustomerVoucherPolicyDto }) policy: CustomerVoucherPolicyDto;
}

export class CustomerVoucherClaimDto {
  @ApiProperty() id: string;
  @ApiProperty() campaignId: string;
  @ApiProperty({ enum: ['CLAIMED', 'REDEEMED'] }) status:
    'CLAIMED' | 'REDEEMED';
  @ApiProperty({ nullable: true }) redeemedAt: Date | null;
  @ApiProperty({ type: CustomerVoucherPolicyDto })
  policySnapshot: CustomerVoucherPolicyDto;
  @ApiProperty({ type: CustomerVoucherCampaignDto })
  campaign: CustomerVoucherCampaignDto;
}

export class CustomerVoucherReservationDto {
  @ApiProperty() id: string;
  @ApiProperty() campaignId: string;
  @ApiProperty() claimId: string;
  @ApiProperty() scopeId: string;
  @ApiProperty() attemptId: string;
  @ApiProperty({ enum: ReservationState }) state: ReservationState;
  @ApiProperty() reservedAt: Date;
  @ApiProperty() expiresAt: Date;
  @ApiProperty({ type: CustomerVoucherPolicyDto })
  policySnapshot: CustomerVoucherPolicyDto;
}

// Explicit allowlists at every level: neither entity fields nor future JSON fields
// become a customer contract automatically. Internal adapters keep their entity types.
function customerPolicy(policy: VoucherPolicy): CustomerVoucherPolicyDto {
  return {
    discount: policy.discount,
    value: policy.value,
    capVnd: policy.capVnd,
    minimumVnd: policy.minimumVnd,
    categoryIds: [...policy.categoryIds],
    serviceIds: [...policy.serviceIds],
    components: ['LABOR', 'PARTS'],
  };
}
export function customerGeneralVoucher(campaign: VoucherCampaign): CustomerGeneralVoucherDto {
  return {
    id: campaign.id,
    code: campaign.code,
    name: campaign.name,
    startsAt: campaign.startsAt,
    endsAt: campaign.endsAt,
    policy: customerPolicy(campaign.policy),
  };
}

export function customerClaim(
  claim: VoucherClaim,
  campaign: VoucherCampaign,
): CustomerVoucherClaimDto {
  return {
    id: claim.id,
    campaignId: claim.campaignId,
    status: claim.redeemedAt ? 'REDEEMED' : 'CLAIMED',
    redeemedAt: claim.redeemedAt,
    policySnapshot: customerPolicy(claim.policySnapshot),
    campaign: {
      code: campaign.code,
      name: campaign.name,
      kind: campaign.kind,
      startsAt: campaign.startsAt,
      endsAt: campaign.endsAt,
      active: campaign.active,
    },
  };
}

export function customerReservation(
  reservation: VoucherReservation,
): CustomerVoucherReservationDto {
  return {
    id: reservation.id,
    campaignId: reservation.campaignId,
    claimId: reservation.claimId,
    scopeId: reservation.scopeId,
    attemptId: reservation.attemptId,
    state: reservation.state,
    reservedAt: reservation.reservedAt,
    expiresAt: reservation.expiresAt,
    policySnapshot: customerPolicy(reservation.policySnapshot),
  };
}
