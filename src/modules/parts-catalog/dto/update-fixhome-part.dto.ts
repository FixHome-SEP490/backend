// src/modules/parts-catalog/dto/update-fixhome-part.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
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

export class UpdateFixHomePartDto {
  @ApiPropertyOptional({
    example: 'FH-BEARING-6204',
    nullable: true,
    description: 'Null clears the optional SKU',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(100)
  sku?: string | null;

  @ApiPropertyOptional({
    example: 'Vòng bi 6204 chính hãng (bản 2026)',
    minLength: 1,
    maxLength: 200,
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    example: 'Vòng bi dùng cho máy giặt cửa trước',
    nullable: true,
    description: 'Null clears the optional description',
    maxLength: 5000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiPropertyOptional({ example: 195000, minimum: 0, maximum: 9999999999.99 })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  sellingPrice?: number;

  @ApiPropertyOptional({
    example: 180,
    description: 'Warranty in days; null clears the configured catalog warranty',
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
    description: 'Null clears the optional warranty policy',
    maxLength: 5000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  warrantyPolicy?: string | null;

  @ApiPropertyOptional({ example: true })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
