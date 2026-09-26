// src/modules/auth/dto/forgot-password.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';
import { NoUnsafeText } from '../../../shared/validation/text.validators';

export class ForgotPasswordDto {
  @ApiProperty({
    example: 'customer@fixhome.vn',
    description: 'Email address of account to reset password',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @Trim()
  @MaxLength(254)
  @NoUnsafeText()
  email: string;
}
