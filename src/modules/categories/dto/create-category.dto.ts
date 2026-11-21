import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  Matches,
} from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';
import { IsAddressText, NoUnsafeText } from '../../../shared/validation/text.validators';

export class CreateCategoryDto {
  @ApiProperty({
    example: 'Điện lạnh',
    description: 'Tên danh mục dịch vụ',
  })
  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  @Trim()
  @MinLength(1)
  @MaxLength(200)
  @IsAddressText({ message: 'Tên chỉ gồm chữ, số và dấu thường gặp, không emoji hay thẻ HTML.' })
  name: string;

  @ApiProperty({
    example: 'DIEN_LANH',
    description: 'Mã định danh danh mục (duy nhất)',
  })
  @IsString()
  @IsNotEmpty({ message: 'code is required' })
  @Trim()
  @MinLength(1)
  @MaxLength(200)
  @Matches(/^[A-Z0-9_-]{2,50}$/, { message: 'Mã chỉ gồm chữ in hoa không dấu, số, gạch dưới hoặc gạch nối (2 đến 50 ký tự).' })
  code: string;

  @ApiPropertyOptional({
    example: 'dien-lanh',
    description: 'URL slug thân thiện',
  })
  @IsOptional()
  @IsString()
  @Trim()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'Đường dẫn chỉ gồm chữ thường không dấu, số và gạch nối.' })
  @MaxLength(100)
  slug?: string;

  @ApiPropertyOptional({
    example: 'Snowflake',
    description: 'Lucide icon key',
  })
  @IsOptional()
  @IsString()
  @Trim()
  iconKey?: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Thứ tự sắp xếp hiển thị',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({
    example: 'Dịch vụ sửa chữa điều hòa, tủ lạnh, máy giặt',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  @NoUnsafeText()
  description?: string;

  @ApiPropertyOptional({ default: true })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
