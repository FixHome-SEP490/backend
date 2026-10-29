import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { getMetadataArgsStorage } from 'typeorm';
import { SupportCaseStatus } from '../../shared/enums';
import { ResolveSupportCaseDto } from './dto/resolve-support-case.dto';
import { SupportCase } from './entities/support-case.entity';

const source = { finalStatus: SupportCaseStatus.RESOLVED, resolutionCode: 'refund_to_wallet',
  reason: 'Đã xác minh điều kiện hoàn tiền và trợ giá của FixHome.', amount: 0,
  grossRefundVnd: 200000 };

describe('funded F3 refund has separately approved original gross and customer NET', () => {
  it('allows customer NET of zero when FixHome funded all costs, with nonzero gross source', () => {
    const instance = plainToInstance(ResolveSupportCaseDto, source);
    expect(validateSync(instance)).toEqual([]);
    expect(instance.amount).toBe(0);
    expect(instance.grossRefundVnd).toBe(200000);
  });

  it.each([0, -1, 2.5, 2_000_000_001, '100000'])(
    'rejects invalid grossRefundVnd %s before any refund transaction',
    amount => {
      const instance = plainToInstance(ResolveSupportCaseDto, { ...source, grossRefundVnd: amount });
      expect(validateSync(instance).some(error => error.property === 'grossRefundVnd')).toBe(true);
    },
  );

  it('keeps the original amount as customer NET and exposes a durable separate funding column', () => {
    const columns = getMetadataArgsStorage().columns.filter(c => c.target === SupportCase);
    const net = columns.find(c => c.propertyName === 'amount');
    const gross = columns.find(c => c.propertyName === 'voucherGrossRefundVnd');
    expect(net?.options.name).toBe('amount');
    expect(gross?.options.name).toBe('voucher_gross_refund_vnd');
    expect(gross?.options.nullable).toBe(true);
  });
});
