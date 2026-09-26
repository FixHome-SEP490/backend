// src/shared/validation/text.validators.ts
import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

/**
 * Ký tự điều khiển C0/C1. Chuỗi chứa `\u0000` đi lọt tới Postgres sẽ làm vỡ
 * câu lệnh với "invalid byte sequence for encoding UTF8", và lỗi đó nổi lên
 * thành HTTP 500 thay vì 400. Chặn ngay từ DTO để người dùng nhận đúng lỗi
 * nhập liệu.
 */
// Chính các ký tự điều khiển này là thứ cần bắt, nên biểu thức bắt buộc phải
// nhắc tới chúng; cảnh báo của linter ở đây là báo nhầm ý định.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/**
 * Ký tự vô hình và ký tự điều khiển chiều viết.
 *
 * Nguy hiểm thật chứ không phải khó tính: `a​b@x.com` và `ab@x.com` hiện
 * lên màn hình giống hệt nhau nhưng là hai email khác nhau, đủ để tạo hai tài
 * khoản mà người dùng lẫn quản trị viên đều không phân biệt nổi. Nhóm
 * `‪-‮` còn đảo ngược chiều hiển thị nên tên hiện ra khác hẳn tên
 * được lưu.
 *
 * Ta từ chối thay vì tự ý xoá, vì xoá âm thầm sẽ biến email người dùng gõ thành
 * một email khác mà họ không hề biết.
 */
const INVISIBLE_CHARS =
  /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

/** Nửa cặp surrogate đứng lẻ — chuỗi UTF-16 hỏng, Postgres cũng từ chối. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function containsUnsafeText(value: string): boolean {
  return (
    CONTROL_CHARS.test(value) ||
    INVISIBLE_CHARS.test(value) ||
    LONE_SURROGATE.test(value)
  );
}

/**
 * Dùng cho mọi trường văn bản một dòng do người dùng nhập. Không nói gì về nội
 * dung, chỉ loại các ký tự không bao giờ nên có trong dữ liệu nhập tay.
 */
export function NoUnsafeText(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'noUnsafeText',
      validator: {
        validate: (value: unknown): boolean =>
          typeof value !== 'string' || !containsUnsafeText(value),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must not contain control or invisible characters`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}

/**
 * Luật ký tự cho tên người: chữ cái của mọi hệ chữ, dấu phụ (tiếng Việt cần),
 * khoảng trắng, dấu nháy đơn, gạch nối và dấu chấm. Đủ cho "Nguyễn Thị Ánh
 * Nguyệt", "Trần Văn A", "O'Brien", "Anne-Marie", "Dr. Smith".
 *
 * Loại emoji, ký hiệu trang trí và thẻ HTML, vì tên hiển thị khắp giao diện web
 * lẫn mobile và trong email gửi đi.
 *
 * GIẢ ĐỊNH: luật này do đội phát triển đặt để bịt lỗ hổng, PO chưa duyệt. Nếu
 * nghiệp vụ muốn cho phép chữ số hoặc emoji trong tên thì sửa đúng biểu thức
 * dưới đây.
 */
const PERSON_NAME_ALLOWED = /^[\p{L}\p{M}][\p{L}\p{M} '’.-]*$/u;

export function IsPersonName(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isPersonName',
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' &&
          !containsUnsafeText(value) &&
          PERSON_NAME_ALLOWED.test(value),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property may only contain letters, spaces, apostrophes, hyphens and periods`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
