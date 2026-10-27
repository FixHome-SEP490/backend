import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { VoucherDiscount, VoucherKind } from '../voucher.types';

export class CreateVoucherCampaignDto {
  @ApiProperty() @Matches(/^[A-Z0-9_-]{3,40}$/) code: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) name: string;
  @ApiProperty({ enum: VoucherKind }) @IsEnum(VoucherKind) kind: VoucherKind;
  @ApiPropertyOptional({ default: false, description: 'Tự cấp bù cho sự cố sửa chữa đã xác minh; chỉ PERSONAL' })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  autoCompensation?: boolean;
  @ApiProperty({ enum: VoucherDiscount })
  @IsEnum(VoucherDiscount)
  discount: VoucherDiscount;
  @ApiProperty() @IsInt() @Min(1) @Max(2147483647) value: number;
  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  capVnd?: number | null;
  @ApiProperty() @IsInt() @Min(0) @Max(2147483647) minimumVnd: number;
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  categoryIds: string[];
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  serviceIds: string[];
  @ApiProperty() @IsDateString({ strict: true }) startsAt: string;
  @ApiProperty() @IsDateString({ strict: true }) endsAt: string;
  @ApiProperty({ example: 100 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  quota: number;
}
export class VoucherCampaignStatusDto {
  @ApiProperty() @IsBoolean() active: boolean;
}
export class ClaimVoucherDto {
  @ApiProperty() @Matches(/^[A-Z0-9_-]{3,40}$/) code: string;
}
export class ApplyVoucherDto {
  @ApiProperty() @IsUUID('4') claimId: string;
  @ApiProperty() @IsUUID('4') scopeId: string;
  @ApiProperty() @IsUUID('4') attemptId: string;
}
export class GrantPersonalVoucherDto {
  // v0 is reserved for existing demo customers; newly generated IDs are v4.
  @ApiProperty() @Matches(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-0[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i) customerId: string;
  /** Stable idempotency identity supplied by the administrator's client. */
  @ApiProperty() @IsUUID('4') grantId: string;
}
