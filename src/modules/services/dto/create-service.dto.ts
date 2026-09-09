import { Trim } from '../../../shared/validation/input.transforms';
import { MaxLength, MinLength, ValidateIf, Max } from 'class-validator';
// src/modules/services/dto/create-service.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateServiceDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    description: 'ID danh má»¥c',
  })
  @IsUUID('4', { message: 'categoryId must be a valid UUID' })
  @IsNotEmpty({ message: 'categoryId is required' })
  categoryId: string;

  @ApiProperty({
    example: 'Sá»­a Ä‘iá»u hÃ²a khÃ´ng mÃ¡t',
    description: 'TÃªn dá»‹ch vá»¥',
  })
  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  @Trim()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({
    example: 'SUA_DH_KHONG_MAT',
    description: 'MÃ£ Ä‘á»‹nh danh duy nháº¥t cá»§a dá»‹ch vá»¥',
  })
  @IsString()
  @IsNotEmpty({ message: 'code is required' })
  @Trim()
  @MinLength(1)
  @MaxLength(200)
  code: string;

  @ApiPropertyOptional({
    example: 'Kiá»ƒm tra gas, block, vá»‡ sinh lÆ°á»›i lá»c',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: 150000,
    description: 'GiÃ¡ sÃ n/kháº£o sÃ¡t cÆ¡ sá»Ÿ',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  basePrice?: number;

  @ApiPropertyOptional({
    example: 100000,
    description: 'Khoáº£ng giÃ¡ tá»‘i thiá»ƒu',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  minPrice?: number;

  @ApiPropertyOptional({
    example: 500000,
    description: 'Khoáº£ng giÃ¡ tá»‘i Ä‘a',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  maxPrice?: number;

  @ApiPropertyOptional({ default: true })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
