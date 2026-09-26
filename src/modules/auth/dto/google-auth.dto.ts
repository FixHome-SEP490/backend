// src/modules/auth/dto/google-auth.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';

/**
 * Web gửi thẳng ID token nhận được từ Google Identity Services.
 *
 * Giới hạn độ dài đặt rộng tay vì JWT của Google có thể dài, nhưng vẫn phải có
 * trần — không có trần thì một chuỗi vài megabyte cũng đi tới tận thư viện xác
 * thực chữ ký trước khi bị từ chối.
 */
export class GoogleIdTokenDto {
  @ApiProperty({ description: 'ID token do Google Identity Services cấp' })
  @IsString()
  @IsNotEmpty({ message: 'idToken is required' })
  @MaxLength(4096)
  idToken: string;

  @ApiPropertyOptional({
    example: 'Web - Chrome on Windows',
    description: 'Mô tả thiết bị, dùng để người dùng nhận ra phiên của mình',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  deviceInfo?: string;
}

/** Mobile đổi mã bàn giao sống 60 giây lấy phiên thật. */
export class GoogleHandoffDto {
  @ApiProperty({ description: 'Mã bàn giao nhận được ở bước quay về app' })
  @IsString()
  @IsNotEmpty({ message: 'code is required' })
  @MaxLength(4096)
  code: string;

  @ApiPropertyOptional({ example: 'Mobile - Android' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  deviceInfo?: string;
}

/**
 * Tham số của bước mở trang đồng ý.
 *
 * `redirect` là địa chỉ app muốn được đưa về. Expo Go sinh địa chỉ này lúc chạy
 * theo IP mạng LAN của từng máy nên không thể liệt kê cứng, vì vậy backend kiểm
 * nó theo danh sách tiền tố cho phép trong GOOGLE_ALLOWED_APP_REDIRECTS.
 */
export class GoogleAuthorizeQueryDto {
  @ApiPropertyOptional({
    example: 'exp://192.168.1.8:8081/--/auth/google',
    description: 'Địa chỉ quay về app; bỏ trống thì dùng web frontend',
  })
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(2048)
  redirect?: string;
}
