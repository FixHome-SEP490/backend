import { ApiProperty } from '@nestjs/swagger';

export class WalletSummaryResponseDto {
  @ApiProperty({ description: 'ID của ví', example: 'd3b07384-d113-49d9-bb43-a62145b206a4' })
  id: string;

  @ApiProperty({ description: 'ID của Kỹ thuật viên', example: 'a1b07384-d113-49d9-bb43-a62145b206a1' })
  technicianId: string;

  @ApiProperty({ description: 'Số dư thực tế hiện tại (VND)', example: 850000 })
  balance: number;

  @ApiProperty({ description: 'Số tiền đang chờ duyệt rút (VND)', example: 0 })
  pendingWithdrawal: number;

  @ApiProperty({ description: 'Hạn mức số dư tối thiểu yêu cầu (VND)', example: 200000 })
  minimumBalance: number;

  @ApiProperty({ description: 'Số dư khả dụng = balance - pendingWithdrawal (VND)', example: 850000 })
  availableBalance: number;

  @ApiProperty({ description: 'Số tiền có thể rút = MAX(availableBalance - minimumBalance, 0) (VND)', example: 650000 })
  withdrawableBalance: number;

  @ApiProperty({ description: 'Đủ điều kiện nhận việc mới (balance >= minimumBalance)', example: true })
  eligibleForJobs: boolean;
}
