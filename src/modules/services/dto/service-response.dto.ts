import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ServicePricingMode } from '../../../shared/enums';

export class ServiceCategorySummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Điện lạnh' })
  name: string;

  @ApiProperty({ example: 'DIEN_LANH' })
  code: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'dien-lanh' })
  slug?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Snowflake' })
  iconKey?: string | null;

  @ApiProperty({ example: 1 })
  sortOrder: number;

  @ApiProperty({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class ServiceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  categoryId: string;

  @ApiPropertyOptional({
    type: ServiceCategorySummaryResponseDto,
    nullable: true,
  })
  category?: ServiceCategorySummaryResponseDto | null;

  @ApiProperty({ example: 'Sửa điều hòa không mát' })
  name: string;

  @ApiProperty({ example: 'SUA_DH_KHONG_MAT' })
  code: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  slug?: string | null;

  @ApiProperty({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0 })
  basePrice: number | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0 })
  minPrice: number | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0 })
  maxPrice: number | null;

  @ApiProperty({ enum: ServicePricingMode })
  pricingMode: ServicePricingMode;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Máy' })
  unit?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0 })
  fixedPrice?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  scopeDescription?: string | null;

  @ApiProperty({ example: 60, minimum: 1 })
  estimatedMinutes: number;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
