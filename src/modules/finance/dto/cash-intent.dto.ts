import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export enum CashIntentScopeKind { SOLO = 'SOLO', VISIT_GROUP = 'VISIT_GROUP' }

export class CreateCashIntentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  commandId: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  voucherReservationId?: string;
}

export class ReceiveCashIntentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  intentId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  commandId: string;

  @ApiProperty({ minimum: 1, maximum: 999999999999 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999999999999)
  receivedAmountVnd: number;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @MaxLength(2048)
  receiptEvidenceUrl?: string;
}

export class CancelCashIntentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  intentId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  commandId: string;
}
