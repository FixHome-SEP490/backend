// src/modules/auth/dto/reset-password.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import {
  IsByteLength,
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';

export class ResetPasswordDto {
  @ApiProperty({
    example: 'customer@fixhome.vn',
    description: 'Email address of account',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @Trim()
  email: string;

  @ApiProperty({
    example: '123456',
    description: '6-digit OTP code received via email',
  })
  @IsString()
  @IsNotEmpty({ message: 'otp code is required' })
  @Trim()
  @Length(6, 6, { message: 'otp must be exactly 6 digits' })
  @Matches(/^[0-9]{6}$/, { message: 'otp must contain only numbers' })
  otp: string;

  @ApiProperty({
    example: 'NewSecurePassword123!',
    description: 'New password (minimum 8 characters, upper, lower, number, special char)',
    minLength: 8,
  })
  @IsString()
  @MinLength(8, { message: 'newPassword must be at least 8 characters long' })
  @IsByteLength(0, 72)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/, {
    message:
      'newPassword requires uppercase, lowercase, number and special character',
  })
  newPassword: string;
}
