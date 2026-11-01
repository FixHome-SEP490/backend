// src/shared/validation/uuid.validators.ts
import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

/**
 * Dạng UUID chuẩn 8-4-4-4-12 chữ số hex, không đòi nibble version hay variant.
 *
 * Các tài khoản seed cũ trên database chung (admin, service manager, kỹ thuật
 * viên, khách hàng) mang id kiểu `a0000000-0000-0000-0000-000000000001`, nibble
 * version bằng 0. `@IsUUID()` của class-validator (validator 13.15, mặc định
 * 'all') chỉ nhận version 1 tới 8 nên trả 400 cho chính id thật của những tài
 * khoản đó, trong khi cột Postgres kiểu uuid vẫn nhận chúng bình thường.
 * Dùng cho các trường nhận id người dùng hoặc hồ sơ kỹ thuật viên. Chuỗi tự do,
 * thiếu ký tự hay sai dấu gạch vẫn bị từ chối.
 */
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value);
}

export function IsCanonicalUuid(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isCanonicalUuid',
      validator: {
        validate: (value) => isCanonicalUuid(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must be a UUID`, validationOptions),
      },
    },
    validationOptions,
  );
}
