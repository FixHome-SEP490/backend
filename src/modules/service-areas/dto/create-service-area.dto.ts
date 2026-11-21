// src/modules/service-areas/dto/create-service-area.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';
import { IsAddressText } from '../../../shared/validation/text.validators';

/** Mã đơn vị hành chính chỉ gồm chữ số (01, 79, 00004, 26734…). */
const ADMIN_CODE = /^\d{1,10}$/;

export class CreateServiceAreaDto {
  @ApiProperty({ example: '01', description: 'Mã tỉnh/thành phố' })
  @IsString()
  @IsNotEmpty({ message: 'provinceCode is required' })
  @Trim()
  @Matches(ADMIN_CODE, { message: 'Mã tỉnh, thành phố chỉ gồm chữ số.' })
  provinceCode: string;

  @ApiProperty({ example: 'Thành phố Hà Nội', description: 'Tên tỉnh/thành phố' })
  @IsString()
  @IsNotEmpty({ message: 'provinceName is required' })
  @Trim()
  @MaxLength(100, { message: 'Tên tỉnh, thành phố tối đa 100 ký tự.' })
  @IsAddressText({ message: 'Tên tỉnh, thành phố không được chứa emoji, thẻ HTML hay ký tự đặc biệt.' })
  provinceName: string;

  @ApiProperty({ example: '00004', description: 'Mã quận/huyện, phường/xã' })
  @IsString()
  @IsNotEmpty({ message: 'districtCode is required' })
  @Trim()
  @Matches(ADMIN_CODE, { message: 'Mã quận, huyện chỉ gồm chữ số.' })
  districtCode: string;

  @ApiProperty({ example: 'Phường Ba Đình', description: 'Tên quận/huyện, phường/xã' })
  @IsString()
  @IsNotEmpty({ message: 'districtName is required' })
  @Trim()
  @MaxLength(100, { message: 'Tên quận, huyện tối đa 100 ký tự.' })
  @IsAddressText({ message: 'Tên quận, huyện không được chứa emoji, thẻ HTML hay ký tự đặc biệt.' })
  districtName: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
