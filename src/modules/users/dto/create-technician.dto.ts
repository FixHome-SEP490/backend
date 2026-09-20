// src/modules/users/dto/create-technician.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Trim, Phone } from '../../../shared/validation/input.transforms';

export class CreateTechnicianDto {
  @ApiProperty({ example: 'tech13@fixhome.vn', description: 'Email đăng nhập của thợ' })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @Trim()
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'Nguyen Van C', description: 'Họ tên thợ' })
  @IsString()
  @Trim()
  @MinLength(2)
  @MaxLength(200)
  @IsNotEmpty({ message: 'fullName is required' })
  fullName: string;

  @ApiPropertyOptional({ example: '0912345678', description: 'Số điện thoại (Việt Nam)' })
  @IsOptional()
  @IsString()
  @Phone()
  @Matches(/^0[35789][0-9]{8}$/, { message: 'phoneNumber must be a valid Vietnamese phone number' })
  phoneNumber?: string;
}
