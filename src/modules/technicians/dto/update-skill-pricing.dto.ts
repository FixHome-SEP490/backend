// src/modules/technicians/dto/update-skill-pricing.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';

export class UpdateSkillPricingDto {
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 9999999999.99,
    example: 150000,
    description:
      'Listed labor price reference. Rejected for FIXED_PRICE services; non-binding for INSPECTION_REQUIRED. Null clears a stale value.',
  })
  @ValidateIf((_dto, value) => value !== undefined && value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  listedLaborPrice?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 3650,
    example: 30,
    description: 'Typical warranty in days. Null clears the value.',
  })
  @ValidateIf((_dto, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(3650)
  typicalWarrantyDays?: number | null;

  @ApiPropertyOptional({
    type: String,
    maxLength: 50,
    example: 'INTERMEDIATE',
    description: 'Skill level label. Trimmed, non-empty when supplied.',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  @Trim()
  @IsNotEmpty()
  @MaxLength(50)
  level?: string;

  @ApiPropertyOptional({
    type: Boolean,
    example: true,
    description: 'Whether this service offering is active for matching.',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
