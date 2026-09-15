// src/modules/parts-catalog/dto/create-fixhome-part.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';

export class CreateFixHomePartDto {
  @ApiPropertyOptional({
    example: 'FH-BEARING-6204',
    description: 'Optional unique SKU; null clears/omits it; normalized to uppercase',
    nullable: true,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(100)
  sku?: string | null;

  @ApiProperty({ example: 'Vòng bi 6204 chính hãng', description: 'Part name', minLength: 1, maxLength: 200 })
  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  @Trim()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({
    example: 'Vòng bi dùng cho máy giặt cửa trước',
    nullable: true,
    maxLength: 5000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiProperty({ example: 185000, description: 'Catalog selling price (VND)', minimum: 0, maximum: 9999999999.99 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  sellingPrice: number;

  @ApiPropertyOptional({
    example: 180,
    description: 'Warranty in days; null means no configured catalog warranty',
    nullable: true,
    minimum: 0,
    maximum: 3650,
  })
  @ValidateIf((_dto, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(3650)
  warrantyDays?: number | null;

  @ApiPropertyOptional({
    example: 'Bảo hành 6 tháng, 1 đổi 1 do lỗi NSX',
    nullable: true,
    maxLength: 5000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  warrantyPolicy?: string | null;

  @ApiPropertyOptional({ default: true })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
