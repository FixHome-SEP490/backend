// src/modules/auth/dto/resend-otp.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, MaxLength } from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';
import { NoUnsafeText } from '../../../shared/validation/text.validators';
import { OtpChannel } from '../../../shared/enums';

export class ResendOtpDto {
  @ApiProperty({
    example: 'customer@fixhome.vn',
    description: 'Email address to resend OTP',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @Trim()
  @MaxLength(254)
  @NoUnsafeText()
  email: string;

  @ApiPropertyOptional({
    enum: OtpChannel,
    default: OtpChannel.EMAIL,
    description: 'Kênh nhận / kiểm tra OTP: EMAIL hoặc SMS (SMS cần số điện thoại)',
  })
  @IsOptional()
  @IsEnum(OtpChannel, { message: 'channel must be EMAIL or SMS' })
  channel?: OtpChannel;
}
