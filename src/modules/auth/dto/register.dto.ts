// src/modules/auth/dto/register.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  MaxLength,
  IsByteLength,
  IsIn,
  ValidateIf,
} from 'class-validator';
import { Trim, Phone } from '../../../shared/validation/input.transforms';
import {
  IsPersonName,
  NoUnsafeText,
} from '../../../shared/validation/text.validators';
import { Role } from '../../../shared/enums';

export class RegisterDto {
  @ApiProperty({
    example: 'customer@fixhome.vn',
    description: 'User email address',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @Trim()
  @MaxLength(254)
  @NoUnsafeText()
  email: string;

  @ApiProperty({
    example: 'SecurePassword123!',
    description: 'Password (minimum 8 characters)',
    minLength: 8,
  })
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters long' })
  @IsByteLength(0, 72)
  // bcrypt cắt chuỗi tại byte NUL đầu tiên, nên một mật khẩu chứa `\u0000` sẽ
  // được băm ngắn hơn hẳn những gì người dùng gõ. Chặn ngay lúc đặt mật khẩu.
  @NoUnsafeText()
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/, {
    message:
      'password requires uppercase, lowercase, number and special character',
  })
  password: string;

  @ApiProperty({ example: 'Nguyen Van A', description: 'Full name' })
  @IsString()
  @Trim()
  @MinLength(2)
  @MaxLength(200)
  @IsNotEmpty({ message: 'fullName is required' })
  @IsPersonName()
  fullName: string;

  @ApiPropertyOptional({
    example: '0912345678',
    description: 'Vietnamese phone number',
  })
  @IsOptional()
  @IsString()
  @Phone()
  @Matches(/^0[35789][0-9]{8}$/, {
    message: 'phoneNumber must be a valid Vietnamese phone number',
  })
  phoneNumber?: string;

  /**
   * Chỉ CUSTOMER được tự đăng ký; tài khoản TECHNICIAN do Service Manager hoặc
   * Admin tạo. `AuthService.register` vẫn luôn từ chối mọi role khác, nhưng
   * trước đây DTO lại khai là nhận cả TECHNICIAN nên Swagger mô tả một đằng mà
   * hệ thống xử một nẻo. Thu hẹp lại cho khớp đúng hành vi thật.
   */
  @ApiPropertyOptional({
    enum: [Role.CUSTOMER],
    default: Role.CUSTOMER,
    description: 'Registration role (CUSTOMER only)',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsEnum(Role, { message: 'role must be a valid role' })
  @IsIn([Role.CUSTOMER])
  role?: Role = Role.CUSTOMER;
}
