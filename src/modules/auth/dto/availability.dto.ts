// src/modules/auth/dto/availability.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, MaxLength } from 'class-validator';
import { Trim, Phone } from '../../../shared/validation/input.transforms';

export class AvailabilityQueryDto {
  @ApiPropertyOptional({ example: 'customer@fixhome.vn' })
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @Trim()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ example: '0901234567' })
  @IsOptional()
  @Phone()
  phoneNumber?: string;
}

export class AvailabilityResponseDto {
  emailTaken: boolean;
  emailPending: boolean;
  phoneTaken: boolean;
}
