import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { WithdrawalStatus } from '../../../shared/enums';

/** PO decision (29/09/2026): the smallest withdrawal is 10.000 ₫. */
export const MIN_WITHDRAWAL_AMOUNT = 10_000;

/** Guards against a typo of extra zeros; far above any real wallet. */
export const MAX_WITHDRAWAL_AMOUNT = 500_000_000;

/**
 * Only the amount. Where the money goes is the technician's saved bank
 * account, never something typed per request — that is what lets the account
 * be checked against KYC once instead of trusted on every withdrawal.
 */
export class CreateWithdrawalDto {
  @ApiProperty({
    description: `Số tiền muốn rút (VND, tối thiểu ${MIN_WITHDRAWAL_AMOUNT.toLocaleString('vi-VN')} ₫)`,
    example: 300000,
  })
  @IsInt()
  @Min(MIN_WITHDRAWAL_AMOUNT)
  @Max(MAX_WITHDRAWAL_AMOUNT)
  amount: number;
}

export class RejectWithdrawalDto {
  @ApiProperty({ description: 'Lý do từ chối yêu cầu rút tiền (bắt buộc)', example: 'Thông tin tài khoản ngân hàng không hợp lệ' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class QueryWithdrawalsDto {
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

  @ApiPropertyOptional({
    description: 'Lọc theo trạng thái yêu cầu rút tiền',
    enum: WithdrawalStatus,
  })
  @IsOptional()
  @IsEnum(WithdrawalStatus)
  status?: WithdrawalStatus;
}

export class WithdrawalResponseDto {
  @ApiProperty({ description: 'ID của yêu cầu rút tiền' })
  id: string;

  @ApiProperty({ description: 'ID ví' })
  walletId: string;

  @ApiProperty({ description: 'ID Kỹ thuật viên' })
  technicianId: string;

  @ApiProperty({ description: 'Số tiền yêu cầu rút (VND)', example: 300000 })
  amount: number;

  @ApiPropertyOptional({ description: 'Ngân hàng thụ hưởng' })
  bankName?: string | null;

  @ApiPropertyOptional({ description: 'Số tài khoản thụ hưởng' })
  bankAccountNumber?: string | null;

  @ApiPropertyOptional({ description: 'Tên chủ tài khoản thụ hưởng' })
  bankAccountName?: string | null;

  @ApiProperty({ description: 'Trạng thái', enum: WithdrawalStatus, example: WithdrawalStatus.PENDING })
  status: WithdrawalStatus;

  @ApiProperty({ description: 'Thời điểm tạo yêu cầu' })
  requestedAt: Date;

  @ApiPropertyOptional({ description: 'Thời điểm xử lý' })
  processedAt?: Date | null;

  @ApiPropertyOptional({ description: 'ID người duyệt/từ chối' })
  processedByUserId?: string | null;

  @ApiPropertyOptional({ description: 'Lý do từ chối (nếu bị reject)' })
  rejectReason?: string | null;

  @ApiPropertyOptional({ description: 'ID giao dịch ví đối ứng (nếu đã duyệt)' })
  transactionId?: string | null;

  @ApiPropertyOptional({ description: 'Mã BIN ngân hàng nhận' })
  bankBin?: string | null;

  @ApiPropertyOptional({ description: 'Mã lệnh chi phía payOS' })
  payoutId?: string | null;

  @ApiPropertyOptional({ description: 'Trạng thái lệnh chi phía payOS, giữ nguyên văn' })
  payoutState?: string | null;

  @ApiPropertyOptional({ description: 'Mã tham chiếu ngân hàng của lệnh chuyển, bằng chứng tiền đã đi' })
  payoutBankReference?: string | null;

  @ApiPropertyOptional({ description: 'Thời điểm gửi lệnh chi sang payOS' })
  payoutAttemptedAt?: Date | null;

  @ApiPropertyOptional({ description: 'Lý do chi thất bại (nếu FAILED)' })
  failureReason?: string | null;

  @ApiPropertyOptional({ description: 'ID giao dịch hoàn tiền về ví (nếu chi thất bại)' })
  refundTransactionId?: string | null;

  @ApiPropertyOptional({ description: 'Thông tin kỹ thuật viên' })
  technician?: {
    id: string;
    fullName?: string;
    phoneNumber?: string;
    email?: string | null;
    avatarUrl?: string | null;
  };
}
