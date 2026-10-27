import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { CashSettlementDeclarationDto } from './finance.dto';

/** Both null is the explicit nonfunded sentinel; zero is never that sentinel. */
export class VoucherCashReservationResponseDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  voucherReservationId: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Server-calculated customer cash due in whole VND.' })
  customerDueVnd: number | null;
}

/** Opaque reservation only. Customer money and voucher discount come from the server. */
export class VoucherReservationDto {
  @ApiProperty({ format: 'uuid', description: 'Server-issued voucher reservation ID.' })
  @IsUUID('4')
  voucherReservationId: string;
}

/** A technician reports the physical cash received; Finance checks the frozen net due. */
export class VoucherCashDeclarationDto extends CashSettlementDeclarationDto {
  @ApiProperty({ format: 'uuid', description: 'Server-issued voucher reservation ID.' })
  @IsUUID('4')
  voucherReservationId: string;
}

export class VoucherCashConfirmationDto extends VoucherReservationDto {
  @ApiProperty({ description: 'Customer confirms the technician received the server-calculated amount.' })
  @IsBoolean()
  agreed: boolean;

  @ApiProperty({ required: false, maxLength: 2000 })
  @ValidateIf(value => value.agreed === false)
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @MaxLength(2000)
  disputeReason?: string;
}
