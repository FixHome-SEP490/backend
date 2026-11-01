import { Transform } from 'class-transformer';
import { ValidateBy, ValidationArguments } from 'class-validator';

/**
 * Luật cho địa chỉ đã lưu của khách và thợ (PO 01/11/2026, bug 29).
 *
 * Địa chỉ đi thẳng vào booking, lời mời, đơn và màn hình của thợ, nên chữ trong
 * địa chỉ chỉ là chữ, số, khoảng trắng và vài dấu thường gặp. Mọi thứ khác bị từ
 * chối chứ không âm thầm xoá: emoji, ký tự vô hình (ZWSP, ZWJ, BOM, dấu đổi
 * chiều viết), ký tự điều khiển kể cả NUL và tab, thẻ HTML. Từ chối thay vì xoá
 * để địa chỉ người dùng gõ không bị đổi thành một địa chỉ khác mà họ không biết.
 */

/** Chữ (kể cả chữ tiếng Việt có dấu), số, khoảng trắng thường và dấu của địa chỉ. */
const ADDRESS_FIELD_ALLOWED = /^[\p{L}\p{N}̀-ͯ ,./()#'’&:–-]+$/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** Chữ cái "trống" của Unicode: nhìn như khoảng trắng nhưng thuộc nhóm chữ. */
const BLANK_LETTERS = /[ᅟᅠㅤﾠ]/u;
/** Dấu thanh chồng chất (chữ "zalgo"); tiếng Việt sau NFC không bao giờ cần quá hai. */
const STACKED_MARKS = /[̀-ͯ]{3,}/u;

export function isAddressFieldText(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    ADDRESS_FIELD_ALLOWED.test(value) &&
    HAS_LETTER_OR_DIGIT.test(value) &&
    !BLANK_LETTERS.test(value) &&
    !STACKED_MARKS.test(value)
  );
}

/**
 * Chuẩn hoá trước khi kiểm: gộp dạng dựng sẵn NFC, đổi khoảng trắng không ngắt
 * thành khoảng trắng thường, gộp nhiều khoảng trắng liền nhau, cắt hai đầu.
 * Chỉ cắt khoảng trắng thường: `trim()` của JavaScript còn lặng lẽ bỏ BOM và
 * xuống dòng ở hai đầu, khi đó chúng lọt qua thay vì bị từ chối.
 */
export function normalizeAddressText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[  ]+/g, ' ')
    .replace(/^ | $/g, '');
}

export const AddressText = () =>
  Transform(({ value }) => (typeof value === 'string' ? normalizeAddressText(value) : value));

/**
 * Chữ trong một ô địa chỉ, `field` là tên ô hiện cho người dùng, `max` là độ dài
 * tối đa. Độ dài kiểm cùng chỗ để ô bắt buộc mà bỏ trống chỉ nhận một câu từ
 * @IsNotEmpty. Chuỗi rỗng và ô không gửi được cho qua ở đây vì lý do đó.
 */
export function IsAddressField(field: string, max: number): PropertyDecorator {
  const blank = (value: unknown) => value === undefined || value === null || value === '';
  const tooLong = (value: unknown) => typeof value === 'string' && value.length > max;
  return ValidateBy({
    name: 'isAddressField',
    constraints: [max],
    validator: {
      validate: (value: unknown): boolean => blank(value) || (!tooLong(value) && isAddressFieldText(value)),
      defaultMessage: (args?: ValidationArguments): string =>
        tooLong(args?.value)
          ? `${field} tối đa ${max} ký tự.`
          : `${field} chỉ được chứa chữ, số, khoảng trắng và các dấu , . / - ( ) #, không chứa emoji, thẻ HTML hay ký tự đặc biệt.`,
    },
  });
}

export const ADDRESS_LOCATION_REQUIRED =
  'Vui lòng chọn vị trí trên bản đồ. Địa chỉ cần có đủ vĩ độ và kinh độ.';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const missing = (value: unknown): boolean => value === undefined || value === null;
const pairIncomplete = (args?: ValidationArguments): boolean => {
  const object = (args?.object ?? {}) as { lat?: unknown; lng?: unknown };
  return missing(object.lat) || missing(object.lng);
};

/**
 * Toạ độ của địa chỉ, bắt buộc đủ cặp. Ô `lat` báo việc thiếu một hay cả hai
 * toạ độ (một câu cho cả cặp), ô `lng` chỉ báo khi chính nó có giá trị sai, để
 * người dùng không nhận hai câu giống nhau. `null` tính là thiếu.
 */
export function IsAddressCoordinate(kind: 'lat' | 'lng'): PropertyDecorator {
  const limit = kind === 'lat' ? 90 : 180;
  const name = kind === 'lat' ? 'Vĩ độ' : 'Kinh độ';
  return ValidateBy({
    name: 'isAddressCoordinate',
    validator: {
      validate: (value: unknown, args?: ValidationArguments): boolean => {
        if (kind === 'lat' && pairIncomplete(args)) return false;
        if (missing(value)) return true;
        return isFiniteNumber(value) && value >= -limit && value <= limit;
      },
      defaultMessage: (args?: ValidationArguments): string =>
        kind === 'lat' && pairIncomplete(args)
          ? ADDRESS_LOCATION_REQUIRED
          : `${name} phải là số từ -${limit} đến ${limit}.`,
    },
  });
}

/** Mã đơn vị hành chính đi kèm địa chỉ, ví dụ 79 hay 760. */
export function IsAreaCode(field: string): PropertyDecorator {
  return ValidateBy({
    name: 'isAreaCode',
    validator: {
      validate: (value: unknown): boolean =>
        typeof value === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(value),
      defaultMessage: () => `${field} không hợp lệ.`,
    },
  });
}
