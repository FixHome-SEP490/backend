import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export enum AdjustmentType {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

export class AdminWalletAdjustmentDto {
  @ApiProperty({ description: 'Loại điều chỉnh: CREDIT (Cộng tiền) hoặc DEBIT (Trừ tiền)', enum: AdjustmentType, example: AdjustmentType.CREDIT })
  @IsEnum(AdjustmentType)
  type: AdjustmentType;

  @ApiProperty({ description: 'Số tiền điều chỉnh (VND, nguyên dương)', example: 50000 })
  @IsInt()
  @Min(1)
  @Max(100000000)
  amount: number;

  @ApiProperty({ description: 'Lý do bắt buộc cho việc điều chỉnh số dư', example: 'Hoàn phí nền tảng do nhầm lẫn nghiệp vụ' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class UpdateWalletConfigDto {
  @ApiPropertyOptional({ description: 'Số dư ví tối thiểu để KTV đủ điều kiện nhận đơn mới (VND)', example: 200000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000000)
  minimumWalletBalance?: number;

  @ApiPropertyOptional({ description: 'Tỷ lệ phí nền tảng tính theo điểm cơ bản (1000 = 10%)', example: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5000)
  platformFeeRateBps?: number;
}

export class WalletConfigResponseDto {
  @ApiProperty({ description: 'Số dư ví tối thiểu để KTV đủ điều kiện nhận việc (VND)', example: 200000 })
  minimumWalletBalance: number;

  @ApiProperty({ description: 'Tỷ lệ phí nền tảng tính theo basis points (1000 = 10%)', example: 1000 })
  platformFeeRateBps: number;

  @ApiProperty({ description: 'Tỷ lệ phần trăm hiển thị', example: '10%' })
  platformFeePercent: string;
}

export class QueryWalletsDto {
  @ApiPropertyOptional({ description: 'Trang cần lấy', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Số lượng bản ghi mỗi trang', default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Tìm theo tên hoặc số điện thoại kỹ thuật viên' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Lọc theo trạng thái đủ điều kiện nhận việc (true/false)' })
  @IsOptional()
  eligible?: string;
}
