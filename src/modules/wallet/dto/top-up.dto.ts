import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class TopUpRequestDto {
  @ApiProperty({ description: 'Số tiền muốn nạp vào ví (tối thiểu 10.000 ₫, tối đa 50.000.000 ₫)', example: 200000 })
  @Type(() => Number)
  @IsInt()
  @Min(10000)
  @Max(50000000)
  amount: number;

  @ApiPropertyOptional({ description: 'Khóa chống gửi trùng (idempotency key)', example: 'TOP_UP_RANDOM_UUID' })
  // System keys (PLATFORM_FEE:ORDER_<id>, WITHDRAW:<id>, ...) all contain ':'.
  // A client key never can, so a top-up cannot pre-empt a platform fee
  // deduction by reusing its key.
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, {
    message: 'idempotencyKey must be 8-64 letters, digits, "_" or "-"',
  })
  idempotencyKey?: string;
}

export class TopUpResponseDto {
  @ApiPropertyOptional({ description: 'Thành công hay không' })
  success?: boolean;

  @ApiProperty({ description: 'Mã định danh giao dịch nạp / paymentId' })
  paymentId: string;

  @ApiPropertyOptional({ description: 'URL thanh toán cổng VNPay (nếu ở chế độ LIVE)' })
  paymentUrl?: string | null;

  @ApiPropertyOptional({ description: 'Số dư ví sau khi nạp (nếu ở chế độ DEMO đã cộng ngay)' })
  balanceAfter?: number | null;

  @ApiProperty({ description: 'Thông báo kết quả' })
  message: string;
}
