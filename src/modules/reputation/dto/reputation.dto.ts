import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, NotEquals } from 'class-validator';

export class QueryReputationDto {
  @ApiPropertyOptional({ enum: ['customer', 'technician'] })
  @IsOptional()
  @IsIn(['customer', 'technician'])
  role?: 'customer' | 'technician';

  @ApiPropertyOptional({ description: 'Tên, email hoặc số điện thoại' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class AdjustReputationDto {
  @ApiProperty({ description: 'Số điểm cộng (dương) hoặc trừ (âm), -100 đến 100, khác 0', example: 10 })
  @Type(() => Number)
  @IsInt({ message: 'Số điểm phải là số nguyên' })
  @Min(-100, { message: 'Số điểm điều chỉnh từ -100 đến 100' })
  @Max(100, { message: 'Số điểm điều chỉnh từ -100 đến 100' })
  @NotEquals(0, { message: 'Số điểm điều chỉnh phải khác 0' })
  delta: number;

  @ApiProperty({ description: 'Lý do điều chỉnh, 5-500 ký tự' })
  @IsString()
  @MinLength(5, { message: 'Ghi lý do điều chỉnh, tối thiểu 5 ký tự' })
  @MaxLength(500, { message: 'Lý do tối đa 500 ký tự' })
  reason: string;
}
