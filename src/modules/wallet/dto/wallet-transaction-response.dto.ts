import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WalletTransactionType } from '../../../shared/enums';

export class WalletTransactionResponseDto {
  @ApiProperty({ description: 'ID giao dịch', example: 'f3b07384-d113-49d9-bb43-a62145b206a9' })
  id: string;

  @ApiProperty({ description: 'ID ví', example: 'd3b07384-d113-49d9-bb43-a62145b206a4' })
  walletId: string;

  @ApiProperty({
    description: 'Loại giao dịch',
    enum: WalletTransactionType,
    example: WalletTransactionType.ONLINE_EARNING,
  })
  type: WalletTransactionType;

  @ApiProperty({ description: 'Số tiền giao dịch (VND)', example: 450000 })
  amount: number;

  @ApiProperty({ description: 'Số dư trước giao dịch (VND)', example: 400000 })
  balanceBefore: number;

  @ApiProperty({ description: 'Số dư sau giao dịch (VND)', example: 850000 })
  balanceAfter: number;

  @ApiPropertyOptional({ description: 'Loại tham chiếu đối ứng', example: 'SERVICE_ORDER' })
  referenceType?: string | null;

  @ApiPropertyOptional({ description: 'ID tham chiếu đối ứng', example: 'order-uuid' })
  referenceId?: string | null;

  @ApiProperty({ description: 'Khóa chống gửi trùng / idempotency key', example: 'ONLINE_EARNING:ORDER_123' })
  idempotencyKey: string;

  @ApiPropertyOptional({ description: 'Mô tả chi tiết', example: 'Thu nhập từ đơn sửa chữa #FH-20260927-ABC' })
  description?: string | null;

  @ApiProperty({ description: 'Thời điểm tạo giao dịch' })
  createdAt: Date;
}
