import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { IsPersonName } from '../../../shared/validation/text.validators';

export class SaveBankAccountDto {
  @ApiProperty({
    description: 'Mã BIN ngân hàng nhận tiền, lấy từ danh sách /technician/wallet/banks',
    example: '970436',
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'bankBin must be a 6-digit bank BIN' })
  bankBin: string;

  @ApiProperty({ description: 'Số tài khoản, chỉ gồm chữ số', example: '0123456789' })
  @IsString()
  @Matches(/^\d{6,19}$/, {
    message: 'accountNumber must contain 6 to 19 digits only',
  })
  accountNumber: string;

  @ApiProperty({
    description:
      'Tên chủ tài khoản. Phải trùng tên đã xác minh KYC (so sánh không dấu, không phân biệt hoa thường).',
    example: 'NGUYEN VAN THO',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @IsPersonName()
  accountName: string;
}

export class BankAccountResponseDto {
  @ApiProperty() bankBin: string;
  @ApiProperty() bankCode: string;
  @ApiProperty({ example: 'Vietcombank' }) bankName: string;
  @ApiProperty() accountNumber: string;
  @ApiProperty({ example: 'NGUYEN VAN THO' }) accountName: string;
  @ApiProperty() updatedAt: Date;
}

export class BankOptionDto {
  @ApiProperty({ example: '970436' }) bin: string;
  @ApiProperty({ example: 'VCB' }) code: string;
  @ApiProperty({ example: 'Vietcombank' }) shortName: string;
  @ApiProperty({ example: 'Ngân hàng TMCP Ngoại Thương Việt Nam' }) name: string;
}
