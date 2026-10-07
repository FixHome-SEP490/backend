import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TopUpRequestDto } from './dto/top-up.dto';
import { toWithdrawalResponse } from './withdrawal.mapper';
import type { WithdrawalRequest } from './entities';
import { maskAccountNumber, maskAccountNumbersInText } from '../../shared/utils/bank-account-mask';

describe('Top-up keys cannot reach system keys', () => {
  const errors = (idempotencyKey: string) =>
    validate(plainToInstance(TopUpRequestDto, { amount: 200000, idempotencyKey })).then((list) => list.map((e) => e.property));

  it('accepts the keys web and mobile generate', async () => {
    expect(await errors('TOPUP_1791234567890_k3j9x2a')).toEqual([]);
  });

  it.each([
    'PLATFORM_FEE:ORDER_11111111-1111-4111-8111-111111111111',
    'WITHDRAW:abc',
    'short',
    'x'.repeat(65),
    'khoá có dấu',
    'TOPUP_😀_12345',
  ])('rejects %s', async (key) => {
    expect(await errors(key)).toEqual(['idempotencyKey']);
  });
});

describe('Bank account numbers leave as the last four digits', () => {
  it('masks a number and leaves short or empty values alone', () => {
    expect(maskAccountNumber('0123456789')).toBe('••••6789');
    expect(maskAccountNumber('1234')).toBe('1234');
    expect(maskAccountNumber(null)).toBeNull();
  });

  it('masks stored descriptions on the way out', () => {
    expect(maskAccountNumbersInText('Rút tiền về Vietcombank - STK 0123456789')).toBe('Rút tiền về Vietcombank - STK ••••6789');
    expect(maskAccountNumbersInText('Thu nhập ròng từ đơn #FH-1')).toBe('Thu nhập ròng từ đơn #FH-1');
  });

  it('never returns the full number on a withdrawal', () => {
    const response = toWithdrawalResponse({ id: 'w-1', amount: 100000, bankAccountNumber: '0123456789' } as WithdrawalRequest);
    expect(response.bankAccountNumber).toBe('••••6789');
  });
});
