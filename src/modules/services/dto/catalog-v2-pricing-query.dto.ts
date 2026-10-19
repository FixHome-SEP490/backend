import { Transform } from 'class-transformer';
import { IsOptional, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { BookingDeviceAttributesDto } from '../../bookings/booking.dto';

/** Flat query facts; same field names and validation as Booking.deviceAttributes. */
export class CatalogV2PricingQueryDto extends BookingDeviceAttributesDto {
  @ApiPropertyOptional({ description: 'Approved variant code; confirms the displayed scope.' })
  @IsOptional() @Matches(/^[A-Z]{2}-\d{2}-\d{2}$/)
  selectedVariantCode?: string;

  @ApiPropertyOptional({ description: 'Alias of selectedVariantCode; values must agree if both are sent.' })
  @IsOptional() @Matches(/^[A-Z]{2}-\d{2}-\d{2}$/)
  variantCode?: string;

  @Transform(({ value }) => typeof value === 'string' ? Number(value) : value)
  declare washerCapacityKg?: number | null;
}
