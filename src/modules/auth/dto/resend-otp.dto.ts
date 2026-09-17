// src/modules/auth/dto/resend-otp.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';

export class ResendOtpDto {
  @ApiProperty({
    example: 'customer@fixhome.vn',
    description: 'Email address to resend OTP',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @Trim()
  email: string;
}
