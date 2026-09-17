// src/modules/auth/dto/verify-otp.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Length, Matches } from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';

export class VerifyOtpDto {
  @ApiProperty({
    example: 'customer@fixhome.vn',
    description: 'Email address registered',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @Trim()
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
}
