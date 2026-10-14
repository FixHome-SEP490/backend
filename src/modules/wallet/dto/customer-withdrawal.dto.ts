import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WithdrawalStatus } from '../../../shared/enums';
import { BankAccountResponseDto } from './bank-account.dto';

export class CustomerWithdrawalResponseDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 150000 }) amount: number;
  @ApiProperty({ enum: [WithdrawalStatus.PROCESSING, WithdrawalStatus.SUCCESS, WithdrawalStatus.FAILED] })
  status: WithdrawalStatus;
  @ApiProperty({ example: 'Vietcombank' }) bankName: string;
  @ApiProperty({ example: '••••6789', description: 'Chỉ 4 số cuối' }) bankAccountNumber: string | null;
  @ApiProperty({ example: 'NGUYEN VAN AN' }) bankAccountName: string;
  @ApiProperty() requestedAt: Date;
  @ApiPropertyOptional() payoutAttemptedAt: Date | null;
  @ApiPropertyOptional({ description: 'Mã tham chiếu ngân hàng khi tiền đã đi' }) payoutBankReference: string | null;
  @ApiPropertyOptional({ description: 'Lý do khi chuyển không thành công' }) failureReason: string | null;
  @ApiPropertyOptional({ description: 'Giao dịch hoàn tiền về ví khi FAILED' }) refundTransactionId: string | null;
  @ApiProperty() updatedAt: Date;
}

export class CustomerWithdrawalInfoDto {
  @ApiProperty({ enum: ['none', 'pending', 'verified', 'rejected'] })
  kycStatus: 'none' | 'pending' | 'verified' | 'rejected';
  @ApiPropertyOptional({ nullable: true }) kycRejectionReason: string | null;
  @ApiProperty() hasBankAccount: boolean;
  @ApiPropertyOptional({ type: BankAccountResponseDto, nullable: true }) bankAccount: BankAccountResponseDto | null;
  @ApiProperty({ example: 10000, description: 'Số tiền rút tối thiểu mỗi lần' }) minimumAmount: number;
  @ApiProperty({ description: 'Rút tối đa: toàn bộ số dư' }) maximumAmount: number;
  @ApiProperty({ description: 'Cổng chi tiền đã cấu hình' }) payoutAvailable: boolean;
  @ApiPropertyOptional({ type: CustomerWithdrawalResponseDto, nullable: true })
  openWithdrawal: CustomerWithdrawalResponseDto | null;
  @ApiProperty({ description: 'Đủ mọi điều kiện để rút ngay' }) canWithdraw: boolean;
}
