import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { WithdrawalStatus } from '../../../shared/enums';

export class CreateWithdrawalDto {
  @ApiProperty({ description: 'Số tiền muốn rút (VND, tối thiểu 50.000 ₫)', example: 300000 })
  @IsInt()
  @Min(50000)
  amount: number;

  @ApiPropertyOptional({ description: 'Tên ngân hàng thụ hưởng', example: 'Vietcombank' })
  @IsOptional()
  @IsString()
  bankName?: string;

  @ApiPropertyOptional({ description: 'Số tài khoản ngân hàng thụ hưởng', example: '0123456789' })
  @IsOptional()
  @IsString()
  bankAccountNumber?: string;

  @ApiPropertyOptional({ description: 'Tên chủ tài khoản thụ hưởng', example: 'NGUYEN VAN THO' })
  @IsOptional()
  @IsString()
  bankAccountName?: string;
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

  @ApiPropertyOptional({ description: 'Thông tin kỹ thuật viên' })
  technician?: {
    id: string;
    fullName?: string;
    phoneNumber?: string;
    avatarUrl?: string | null;
  };
}
