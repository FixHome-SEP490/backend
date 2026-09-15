// src/modules/technicians/dto/technician-service-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ServicePricingMode } from '../../../shared/enums';

export class TechnicianServiceSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Sửa điều hòa không mát' })
  name: string;

  @ApiProperty({ enum: ServicePricingMode })
  pricingMode: ServicePricingMode;

  @ApiProperty({ example: true })
  isActive: boolean;
}

export class TechnicianServiceOfferingResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  serviceId: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    example: 150000,
  })
  listedLaborPrice: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    example: 30,
  })
  typicalWarrantyDays: number | null;

  @ApiProperty({ example: 'INTERMEDIATE', maxLength: 50 })
  level: string;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiPropertyOptional({
    type: TechnicianServiceSummaryDto,
    nullable: true,
  })
  service?: TechnicianServiceSummaryDto | null;
}
