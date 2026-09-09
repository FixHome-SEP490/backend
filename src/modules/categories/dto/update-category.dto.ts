import { Trim } from '../../../shared/validation/input.transforms';
import { MaxLength, MinLength, ValidateIf } from 'class-validator';
// src/modules/categories/dto/update-category.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsString } from 'class-validator';

export class UpdateCategoryDto {
  @ApiPropertyOptional({ example: 'Äiá»‡n láº¡nh dÃ¢n dá»¥ng' })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'MÃ´ táº£ chi tiáº¿t cáº­p nháº­t' })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: true })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
