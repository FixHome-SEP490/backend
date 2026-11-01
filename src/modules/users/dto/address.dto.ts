// src/modules/users/dto/address.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  ValidateIf,
} from 'class-validator';
import { Address } from '../entities/address.entity';
import {
  AddressText,
  IsAddressCoordinate,
  IsAddressField,
  IsAreaCode,
} from '../../../shared/validation/address.validators';

/**
 * Địa chỉ lưu của khách và thợ (PO 01/11/2026, bug 29): bắt buộc đủ cặp toạ độ
 * hợp lệ, chữ trong các ô địa chỉ chỉ là chữ, số, khoảng trắng và dấu thường gặp.
 * Thông báo bằng tiếng Việt vì web và mobile hiện nguyên văn cạnh ô nhập.
 */
const required = (field: string) => ({ message: `${field} không được để trống.` });

/** PATCH chạm vào vị trí (chữ địa chỉ, mã vùng hoặc toạ độ) thì phải gửi lại đủ cặp toạ độ. */
const LOCATION_FIELDS = ['line1', 'ward', 'district', 'province', 'provinceCode', 'districtCode', 'lat', 'lng'] as const;
function touchesLocation(dto: Record<string, unknown>): boolean {
  return LOCATION_FIELDS.some((field) => dto[field] !== undefined);
}

/** Ô bắt buộc trong PATCH: bỏ qua khi không gửi, gửi null hay chuỗi rỗng thì bị từ chối. */
const sent = (_dto: object, value: unknown): boolean => value !== undefined;

export class CreateAddressDto {
  @ApiPropertyOptional({ example: 'Nhà riêng', maxLength: 100 })
  @IsOptional()
  @AddressText()
  @IsAddressField('Tên gợi nhớ', 100)
  label?: string;

  @ApiProperty({ example: '12 Tân Trào, Phường Tân Phú', maxLength: 255 })
  @AddressText()
  @IsNotEmpty(required('Địa chỉ cụ thể'))
  @IsAddressField('Địa chỉ cụ thể', 255)
  line1: string;

  @ApiPropertyOptional({ example: 'Phường Bến Thành', maxLength: 100 })
  @IsOptional()
  @AddressText()
  @IsAddressField('Phường, xã', 100)
  ward?: string;

  @ApiProperty({ example: 'Quận 1', maxLength: 100 })
  @AddressText()
  @IsNotEmpty(required('Quận, huyện'))
  @IsAddressField('Quận, huyện', 100)
  district: string;

  @ApiProperty({ example: 'TP. Hồ Chí Minh', maxLength: 100 })
  @AddressText()
  @IsNotEmpty(required('Tỉnh, thành phố'))
  @IsAddressField('Tỉnh, thành phố', 100)
  province: string;

  @ApiPropertyOptional({ example: '79' })
  @IsOptional()
  @IsAreaCode('Mã tỉnh, thành phố')
  provinceCode?: string;

  @ApiPropertyOptional({ example: '760' })
  @IsOptional()
  @IsAreaCode('Mã quận, huyện')
  districtCode?: string;

  @ApiProperty({ example: 10.7769, minimum: -90, maximum: 90, description: 'Required together with lng.' })
  @IsAddressCoordinate('lat')
  lat: number;

  @ApiProperty({ example: 106.7009, minimum: -180, maximum: 180, description: 'Required together with lat.' })
  @IsAddressCoordinate('lng')
  lng: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @ApiPropertyOptional({ example: 'Nhà riêng', maxLength: 100 })
  @IsOptional()
  @AddressText()
  @IsAddressField('Tên gợi nhớ', 100)
  label?: string;

  @ApiPropertyOptional({ example: '12 Tân Trào, Phường Tân Phú', maxLength: 255 })
  @ValidateIf(sent)
  @AddressText()
  @IsNotEmpty(required('Địa chỉ cụ thể'))
  @IsAddressField('Địa chỉ cụ thể', 255)
  line1?: string;

  @ApiPropertyOptional({ example: 'Phường Bến Thành', maxLength: 100 })
  @IsOptional()
  @AddressText()
  @IsAddressField('Phường, xã', 100)
  ward?: string;

  @ApiPropertyOptional({ example: 'Quận 1', maxLength: 100 })
  @ValidateIf(sent)
  @AddressText()
  @IsNotEmpty(required('Quận, huyện'))
  @IsAddressField('Quận, huyện', 100)
  district?: string;

  @ApiPropertyOptional({ example: 'TP. Hồ Chí Minh', maxLength: 100 })
  @ValidateIf(sent)
  @AddressText()
  @IsNotEmpty(required('Tỉnh, thành phố'))
  @IsAddressField('Tỉnh, thành phố', 100)
  province?: string;

  @ApiPropertyOptional({ example: 10.7769, minimum: -90, maximum: 90, description: 'Required together with lng whenever the address text, area or coordinates change.' })
  @ValidateIf(touchesLocation)
  @IsAddressCoordinate('lat')
  lat?: number;

  @ApiPropertyOptional({ example: 106.7009, minimum: -180, maximum: 180, description: 'Required together with lat whenever the address text, area or coordinates change.' })
  @ValidateIf(touchesLocation)
  @IsAddressCoordinate('lng')
  lng?: number;

  @ApiPropertyOptional({ example: '79' })
  @IsOptional()
  @IsAreaCode('Mã tỉnh, thành phố')
  provinceCode?: string;

  @ApiPropertyOptional({ example: '760' })
  @IsOptional()
  @IsAreaCode('Mã quận, huyện')
  districtCode?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class AddressResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiPropertyOptional()
  label?: string | null;

  @ApiProperty()
  line1: string;

  @ApiPropertyOptional()
  ward?: string | null;

  @ApiProperty()
  district: string;

  @ApiProperty()
  province: string;

  @ApiPropertyOptional()
  provinceCode?: string | null;

  @ApiPropertyOptional()
  districtCode?: string | null;

  @ApiPropertyOptional()
  lat?: number | null;

  @ApiPropertyOptional()
  lng?: number | null;

  @ApiProperty()
  isDefault: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  static fromEntity(address: Address): AddressResponseDto {
    return {
      id: address.id,
      userId: address.userId,
      label: address.label,
      line1: address.line1,
      ward: address.ward,
      district: address.district,
      province: address.province,
      provinceCode: address.provinceCode,
      districtCode: address.districtCode,
      lat: address.lat != null ? Number(address.lat) : null,
      lng: address.lng != null ? Number(address.lng) : null,
      isDefault: address.isDefault,
      createdAt: address.createdAt,
      updatedAt: address.updatedAt,
    };
  }
}
