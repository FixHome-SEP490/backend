// src/modules/auth/dto/verify-otp.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';
import { NoUnsafeText } from '../../../shared/validation/text.validators';
import { OtpChannel } from '../../../shared/enums';

export class VerifyOtpDto {
  @ApiProperty({
    example: 'customer@fixhome.vn',
    description: 'Email address registered',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @Trim()
  @MaxLength(254)
  @NoUnsafeText()
  email: string;

  @ApiProperty({
    example: '123456',
    description: '6-digit OTP code',
  })
  @IsString()
  @IsNotEmpty({ message: 'otp code is required' })
  @Trim()
  @Length(6, 6, { message: 'otp must be exactly 6 digits' })
  @Matches(/^[0-9]{6}$/, { message: 'otp must contain only numbers' })
  otp: string;

  @ApiPropertyOptional({
    enum: OtpChannel,
    default: OtpChannel.EMAIL,
    description: 'Kênh nhận / kiểm tra OTP: EMAIL hoặc SMS (SMS cần số điện thoại)',
  })
  @IsOptional()
  @IsEnum(OtpChannel, { message: 'channel must be EMAIL or SMS' })
  channel?: OtpChannel;
}

/** Xác thực email / SĐT trong profile: người dùng đã đăng nhập nên chỉ cần mã. */
export class ConfirmOtpDto {
  @ApiProperty({ example: '123456', description: '6-digit OTP code' })
  @IsString()
  @IsNotEmpty({ message: 'otp code is required' })
  @Trim()
  @Matches(/^[0-9]{6}$/, { message: 'otp must contain only numbers' })
  otp: string;
}
