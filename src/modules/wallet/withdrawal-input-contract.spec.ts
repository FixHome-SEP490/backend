// src/modules/wallet/withdrawal-input-contract.spec.ts
//
// Hợp đồng nhập liệu của rút tiền và tài khoản ngân hàng.
//
// Đây là chỗ tiền đi ra khỏi hệ thống, nên thử cạn như auth: ký tự điều khiển,
// emoji, ký tự vô hình, chuỗi 2.000 ký tự, số âm, số lẻ, và cả những kiểu dữ
// liệu sai loại. Nhóm cuối giữ lại hành vi đúng để lần sau siết thêm không vô
// tình chặn nhầm tên tiếng Việt có dấu.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateWithdrawalDto,
  MAX_WITHDRAWAL_AMOUNT,
  MIN_WITHDRAWAL_AMOUNT,
  SaveBankAccountDto,
} from './dto';

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

const VALID_ACCOUNT = {
  bankBin: '970436',
  accountNumber: '0123456789',
  accountName: 'NGUYEN VAN THO',
};

describe('Hợp đồng nhập liệu của rút tiền', () => {
  describe('số tiền rút', () => {
    it('nhận đúng mức tối thiểu 10.000 ₫', () => {
      expect(MIN_WITHDRAWAL_AMOUNT).toBe(10_000);
      expect(invalidProps(CreateWithdrawalDto, { amount: 10_000 })).toEqual([]);
    });

    it.each([
      ['dưới mức tối thiểu một đồng', 9_999],
      ['bằng không', 0],
      ['số âm', -50_000],
      ['số lẻ', 10_000.5],
      ['vượt trần chống gõ thừa số 0', MAX_WITHDRAWAL_AMOUNT + 1],
      ['NaN', Number.NaN],
      ['vô cực', Number.POSITIVE_INFINITY],
    ])('chặn %s', (_label, amount) => {
      expect(invalidProps(CreateWithdrawalDto, { amount })).toContain('amount');
    });

    it.each([
      ['chuỗi số', '50000'],
      ['chuỗi rỗng', ''],
      ['null', null],
      ['mảng', [50_000]],
      ['object', { value: 50_000 }],
      ['boolean', true],
    ])('chặn kiểu dữ liệu sai: %s', (_label, amount) => {
      expect(invalidProps(CreateWithdrawalDto, { amount })).toContain('amount');
    });

    it('chặn khi thiếu hẳn số tiền', () => {
      expect(invalidProps(CreateWithdrawalDto, {})).toContain('amount');
    });

    // Trước đây client gửi kèm số tài khoản theo từng lệnh rút. Giờ nơi nhận
    // tiền chỉ lấy từ tài khoản đã lưu và đã so tên KYC, nên body không được
    // phép chở thông tin ngân hàng nữa.
    it.each(['bankName', 'bankAccountNumber', 'bankAccountName', 'bankBin'])(
      'không cho gửi kèm %s trong lệnh rút',
      (field) => {
        expect(
          invalidProps(CreateWithdrawalDto, { amount: 50_000, [field]: 'x' }),
        ).toContain(field);
      },
    );
  });

  describe('mã BIN ngân hàng', () => {
    it.each([
      ['chữ', 'VCB123'],
      ['thiếu một số', '97043'],
      ['thừa một số', '9704360'],
      ['có khoảng trắng', '970 436'],
      ['chữ số full-width', '９７０４３６'],
      ['2.000 chữ số', '9'.repeat(2000)],
      ['rỗng', ''],
    ])('chặn %s', (_label, bankBin) => {
      expect(
        invalidProps(SaveBankAccountDto, { ...VALID_ACCOUNT, bankBin }),
      ).toContain('bankBin');
    });
  });

  describe('số tài khoản', () => {
    it.each([
      ['quá ngắn', '12345'],
      ['quá dài', '1'.repeat(20)],
      ['có chữ', '01234ABC89'],
      ['có gạch nối', '0123-456-789'],
      ['có khoảng trắng', '0123 456 789'],
      ['có dấu chấm', '0123.456.789'],
      ['chữ số Ả Rập', '٠١٢٣٤٥٦٧٨٩'],
      ['chữ số full-width', '０１２３４５６７８９'],
      ['emoji', '0123456789🔥'],
      ['byte NUL', '0123456\u0000789'],
      ['ký tự vô hình', '0123456​789'],
      ['2.000 chữ số', '1'.repeat(2000)],
      ['số âm', '-0123456789'],
    ])('chặn %s', (_label, accountNumber) => {
      expect(
        invalidProps(SaveBankAccountDto, { ...VALID_ACCOUNT, accountNumber }),
      ).toContain('accountNumber');
    });

    it('chặn khi gửi dạng số thay vì chuỗi, vì số 0 đứng đầu sẽ mất', () => {
      expect(
        invalidProps(SaveBankAccountDto, {
          ...VALID_ACCOUNT,
          accountNumber: 123456789,
        }),
      ).toContain('accountNumber');
    });
  });

  describe('tên chủ tài khoản', () => {
    it.each([
      ['emoji', 'NGUYEN 🔥 VAN THO'],
      ['chữ số', 'NGUYEN VAN THO 2'],
      ['thẻ HTML', '<b>NGUYEN VAN THO</b>'],
      ['byte NUL', 'NGUYEN\u0000VAN THO'],
      ['chuỗi thoát ANSI', 'NGUYEN\u001b[31m VAN THO'],
      ['ký tự vô hình', 'NGUYEN​VAN THO'],
      ['đảo chiều văn bản', 'NGUYEN‮VAN THO'],
      ['bắt đầu bằng khoảng trắng', ' NGUYEN VAN THO'],
      ['2.000 ký tự', 'A'.repeat(2000)],
      ['rỗng', ''],
      ['ký hiệu', 'NGUYEN VAN THO @@'],
    ])('chặn %s', (_label, accountName) => {
      expect(
        invalidProps(SaveBankAccountDto, { ...VALID_ACCOUNT, accountName }),
      ).toContain('accountName');
    });

    it('chặn khi vượt 128 ký tự', () => {
      expect(
        invalidProps(SaveBankAccountDto, {
          ...VALID_ACCOUNT,
          accountName: 'A'.repeat(129),
        }),
      ).toContain('accountName');
    });
  });

  describe('dạng đúng phải qua', () => {
    it.each([
      ['viết hoa không dấu như trên thẻ', 'NGUYEN VAN THO'],
      ['có dấu tiếng Việt', 'Nguyễn Văn Thọ'],
      ['chữ đ', 'Đặng Thị Đào'],
      ['viết thường', 'nguyen van tho'],
    ])('nhận tên %s', (_label, accountName) => {
      expect(
        invalidProps(SaveBankAccountDto, { ...VALID_ACCOUNT, accountName }),
      ).toEqual([]);
    });

    it.each([
      ['6 chữ số', '123456'],
      ['19 chữ số', '1'.repeat(19)],
      ['số 0 đứng đầu', '0001234567'],
    ])('nhận số tài khoản %s', (_label, accountNumber) => {
      expect(
        invalidProps(SaveBankAccountDto, { ...VALID_ACCOUNT, accountNumber }),
      ).toEqual([]);
    });
  });
});
