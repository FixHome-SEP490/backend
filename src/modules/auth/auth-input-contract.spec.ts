// src/modules/auth/auth-input-contract.spec.ts
//
// Khoá lại hợp đồng nhập liệu của các endpoint auth.
//
// Mỗi ca ở đây bắt nguồn từ một lần thử thật vào backend đang chạy. Bốn nhóm
// đầu là lỗi đã tìm được và đã sửa; các nhóm sau là hành vi đúng cần giữ, để
// lần sau ai siết thêm validation thì không vô tình chặn nhầm tên tiếng Việt
// hay mật khẩu có ký tự đặc biệt hợp lệ.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResendOtpDto,
  ResetPasswordDto,
  VerifyOtpDto,
} from './dto';
import { Role } from '../../shared/enums';

/** Trả về danh sách tên thuộc tính không hợp lệ, rỗng nghĩa là qua hết. */
function invalidProps<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
): string[] {
  const dto = plainToInstance(cls, payload);
  return validateSync(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((error) => error.property);
}

const VALID_REGISTER = {
  email: 'nguoidung@example.com',
  password: 'TestPass123!',
  fullName: 'Nguyen Van A',
};

describe('Hợp đồng nhập liệu của auth', () => {
  describe('ký tự điều khiển', () => {
    // Trước khi sửa: `\u0000` lọt qua hết validator rồi mới chết ở Postgres với
    // "invalid byte sequence for encoding UTF8", nổi lên thành HTTP 500.
    it('chặn byte NUL trong fullName', () => {
      expect(
        invalidProps(RegisterDto, {
          ...VALID_REGISTER,
          fullName: 'QA\u0000Nguoi Dung',
        }),
      ).toContain('fullName');
    });

    it('chặn ký tự điều khiển và chuỗi thoát ANSI trong fullName', () => {
      expect(
        invalidProps(RegisterDto, {
          ...VALID_REGISTER,
          fullName: 'QA\u0007\u001b[31mNguoi Dung',
        }),
      ).toContain('fullName');
    });

    // bcrypt cắt chuỗi tại byte NUL đầu tiên, nên mật khẩu bị băm ngắn hơn
    // những gì người dùng thực sự gõ.
    it('chặn byte NUL trong password lúc đăng ký', () => {
      expect(
        invalidProps(RegisterDto, {
          ...VALID_REGISTER,
          password: 'TestPass123!\u0000thua',
        }),
      ).toContain('password');
    });

    it('chặn byte NUL trong newPassword lúc đặt lại mật khẩu', () => {
      expect(
        invalidProps(ResetPasswordDto, {
          email: 'nguoidung@example.com',
          otp: '123456',
          newPassword: 'TestPass123!\u0000thua',
        }),
      ).toContain('newPassword');
    });
  });

  describe('ký tự vô hình', () => {
    // Trước khi sửa: `qa​.p06@example.com` qua được IsEmail và tạo tài
    // khoản thật. Nhìn trên màn hình nó giống hệt `qa.p06@example.com`.
    it('chặn zero-width space trong email đăng ký', () => {
      expect(
        invalidProps(RegisterDto, {
          ...VALID_REGISTER,
          email: 'nguoi​dung@example.com',
        }),
      ).toContain('email');
    });

    it('chặn zero-width space trong email đăng nhập', () => {
      expect(
        invalidProps(LoginDto, {
          email: 'nguoi​dung@example.com',
          password: 'TestPass123!',
        }),
      ).toContain('email');
    });

    it('chặn zero-width space trong identifier đăng nhập', () => {
      expect(
        invalidProps(LoginDto, {
          identifier: 'nguoi​dung@example.com',
          password: 'TestPass123!',
        }),
      ).toContain('identifier');
    });

    it.each([
      ['soft hyphen', '­'],
      ['zero-width non-joiner', '‌'],
      ['left-to-right mark', '‎'],
      ['word joiner', '⁠'],
      ['byte order mark', '﻿'],
    ])('chặn %s trong email', (_ten, ky_tu) => {
      expect(
        invalidProps(RegisterDto, {
          ...VALID_REGISTER,
          email: `nguoi${ky_tu}dung@example.com`,
        }),
      ).toContain('email');
    });

    it('chặn các endpoint OTP nhận email có ký tự vô hình', () => {
      const email = 'nguoi​dung@example.com';
      expect(invalidProps(ForgotPasswordDto, { email })).toContain('email');
      expect(invalidProps(ResendOtpDto, { email })).toContain('email');
      expect(invalidProps(VerifyOtpDto, { email, otp: '123456' })).toContain(
        'email',
      );
    });
  });

  describe('luật ký tự cho tên người', () => {
    // GIẢ ĐỊNH: luật do đội phát triển đặt, PO chưa duyệt. Xem .claude/TASKLIST.md.
    it.each([
      ['emoji', 'Nguyen 🔥 Van A'],
      ['ký hiệu trang trí', '★☆♠♣♥♦'],
      ['thẻ HTML', '<script>alert(1)</script>'],
      ['đảo chiều viết RTL', 'QA‮kcatta‬'],
      ['chuỗi SQL', "Robert'); DROP TABLE users;--"],
    ])('chặn %s trong fullName', (_ten, ten) => {
      expect(
        invalidProps(RegisterDto, { ...VALID_REGISTER, fullName: ten }),
      ).toContain('fullName');
    });

    it.each([
      ['tiếng Việt có dấu', 'Nguyễn Thị Ánh Nguyệt'],
      ['dấu nháy đơn', "Mary O'Brien"],
      ['gạch nối', 'Anne-Marie Dupont'],
      ['dấu chấm', 'Dr. Tran Van B'],
      ['chữ Nhật', '山田太郎'],
    ])('vẫn nhận %s', (_ten, ten) => {
      expect(
        invalidProps(RegisterDto, { ...VALID_REGISTER, fullName: ten }),
      ).not.toContain('fullName');
    });
  });

  describe('giới hạn độ dài', () => {
    it.each([
      ['fullName', 'fullName', 'A'.repeat(2000)],
      ['email', 'email', `${'a'.repeat(2000)}@example.com`],
    ])('chặn %s dài 2.000 ký tự', (_ten, truong, gia_tri) => {
      expect(
        invalidProps(RegisterDto, { ...VALID_REGISTER, [truong]: gia_tri }),
      ).toContain(truong);
    });

    it('chặn password dài 2.000 ký tự lúc đăng nhập', () => {
      expect(
        invalidProps(LoginDto, {
          email: 'nguoidung@example.com',
          password: 'A'.repeat(2000),
        }),
      ).toContain('password');
    });

    // bcrypt chỉ đọc 72 byte đầu; phần dư không ảnh hưởng gì tới mật khẩu nên
    // nhận vào sẽ khiến người dùng tin nhầm là mật khẩu của mình dài hơn thật.
    it('chặn password vượt 72 byte lúc đăng ký', () => {
      expect(
        invalidProps(RegisterDto, {
          ...VALID_REGISTER,
          password: `Aa1!${'x'.repeat(80)}`,
        }),
      ).toContain('password');
    });

    it('chặn phoneNumber dài 2.000 ký tự', () => {
      expect(
        invalidProps(RegisterDto, {
          ...VALID_REGISTER,
          phoneNumber: '0'.repeat(2000),
        }),
      ).toContain('phoneNumber');
    });
  });

  describe('vai trò khi tự đăng ký', () => {
    // AuthService.register luôn từ chối mọi role khác CUSTOMER, nhưng DTO từng
    // khai là nhận cả TECHNICIAN nên Swagger mô tả sai hành vi thật.
    it('chặn tự đăng ký vai trò TECHNICIAN', () => {
      expect(
        invalidProps(RegisterDto, {
          ...VALID_REGISTER,
          role: Role.TECHNICIAN,
        }),
      ).toContain('role');
    });

    it('chặn tự đăng ký vai trò ADMIN', () => {
      expect(
        invalidProps(RegisterDto, { ...VALID_REGISTER, role: Role.ADMIN }),
      ).toContain('role');
    });

    it('nhận vai trò CUSTOMER và nhận cả khi bỏ trống', () => {
      expect(
        invalidProps(RegisterDto, { ...VALID_REGISTER, role: Role.CUSTOMER }),
      ).toHaveLength(0);
      expect(invalidProps(RegisterDto, VALID_REGISTER)).toHaveLength(0);
    });
  });

  describe('hành vi đúng cần giữ nguyên', () => {
    it('chặn trường lạ gửi kèm', () => {
      expect(
        invalidProps(RegisterDto, { ...VALID_REGISTER, isAdmin: true }),
      ).toContain('isAdmin');
    });

    it('chặn fullName toàn khoảng trắng', () => {
      expect(
        invalidProps(RegisterDto, { ...VALID_REGISTER, fullName: '     ' }),
      ).toContain('fullName');
    });

    it('chặn emoji trong email', () => {
      expect(
        invalidProps(RegisterDto, {
          ...VALID_REGISTER,
          email: 'nguoi🔥dung@example.com',
        }),
      ).toContain('email');
    });

    it('chặn số điện thoại không đúng dạng Việt Nam', () => {
      expect(
        invalidProps(RegisterDto, {
          ...VALID_REGISTER,
          phoneNumber: '12345',
        }),
      ).toContain('phoneNumber');
    });

    it('nhận số điện thoại Việt Nam hợp lệ', () => {
      expect(
        invalidProps(RegisterDto, {
          ...VALID_REGISTER,
          phoneNumber: '0912345678',
        }),
      ).toHaveLength(0);
    });

    it('nhận mật khẩu có ký tự đặc biệt và emoji trong giới hạn 72 byte', () => {
      expect(
        invalidProps(RegisterDto, { ...VALID_REGISTER, password: 'Aa1🔥x!yz' }),
      ).toHaveLength(0);
    });

    it('chặn OTP không phải sáu chữ số', () => {
      const email = 'nguoidung@example.com';
      expect(invalidProps(VerifyOtpDto, { email, otp: '12345' })).toContain(
        'otp',
      );
      expect(invalidProps(VerifyOtpDto, { email, otp: 'abcdef' })).toContain(
        'otp',
      );
      expect(invalidProps(VerifyOtpDto, { email, otp: '123456' })).toHaveLength(
        0,
      );
    });
  });
});
