import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

export class TopUpRequestDto {
  @ApiProperty({ description: 'Số tiền muốn nạp vào ví (tối thiểu 10.000 ₫, tối đa 50.000.000 ₫)', example: 200000 })
  @IsInt()
  @Min(10000)
  @Max(50000000)
  amount: number;

  @ApiProperty({ description: 'Khóa chống gửi trùng (idempotency key)', example: 'TOP_UP_RANDOM_UUID' })
  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}

export class TopUpResponseDto {
  @ApiProperty({ description: 'Thành công hay không' })
  success: boolean;

  @ApiProperty({ description: 'Mã định danh giao dịch nạp / paymentId' })
  paymentId: string;

  @ApiPropertyOptional({ description: 'URL thanh toán cổng VNPay (nếu ở chế độ LIVE)' })
  paymentUrl?: string | null;

  @ApiPropertyOptional({ description: 'Số dư ví sau khi nạp (nếu ở chế độ DEMO đã cộng ngay)' })
  balanceAfter?: number | null;

  @ApiProperty({ description: 'Thông báo kết quả' })
  message: string;
}
