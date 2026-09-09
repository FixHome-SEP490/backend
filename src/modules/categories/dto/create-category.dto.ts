import { Trim } from '../../../shared/validation/input.transforms';
import { MaxLength, MinLength, ValidateIf } from 'class-validator';
// src/modules/categories/dto/create-category.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsString } from 'class-validator';

export class CreateCategoryDto {
  @ApiProperty({
    example: 'Äiá»‡n láº¡nh',
    description: 'TÃªn danh má»¥c dá»‹ch vá»¥',
  })
  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  @Trim()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({
    example: 'DIEN_LANH',
    description: 'MÃ£ Ä‘á»‹nh danh danh má»¥c (duy nháº¥t)',
  })
  @IsString()
  @IsNotEmpty({ message: 'code is required' })
  @Trim()
  @MinLength(1)
  @MaxLength(200)
  code: string;

  @ApiPropertyOptional({
    example: 'Dá»‹ch vá»¥ sá»­a chá»¯a Ä‘iá»u hÃ²a, tá»§ láº¡nh, mÃ¡y giáº·t',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  description?: string;

  @ApiPropertyOptional({ default: true })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
