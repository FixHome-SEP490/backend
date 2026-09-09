import { Trim } from '../../../shared/validation/input.transforms';
import { MaxLength, MinLength, ValidateIf, Max } from 'class-validator';
// src/modules/services/dto/update-service.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsString, IsUUID, Min } from 'class-validator';

export class UpdateServiceDto {
  @ApiPropertyOptional({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsUUID('4')
  categoryId?: string;

  @ApiPropertyOptional({ example: 'Sá»­a Ä‘iá»u hÃ²a rÃ² nÆ°á»›c' })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    example: 'ThÃ´ng táº¯c Ä‘Æ°á»ng á»‘ng thoÃ¡t nÆ°á»›c',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 180000 })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  basePrice?: number;

  @ApiPropertyOptional({ example: 120000 })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  minPrice?: number;

  @ApiPropertyOptional({ example: 600000 })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  maxPrice?: number;

  @ApiPropertyOptional({ example: true })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
