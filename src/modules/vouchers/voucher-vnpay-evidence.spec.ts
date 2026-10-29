import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateSignedVoucherVnpayCallback, parseVnpayPaidAt } from './voucher-vnpay-evidence';

const secret = 'isolated-test-secret';
const intent = {
  attemptId: 'voucher-attempt-1', customerDueVnd: 450_000, merchantCode: 'TMNCODE01',
  reservedAt: new Date('2026-10-26T15:00:00Z'),
  expiresAt: new Date('2026-10-26T15:15:00Z'),
  initiatedAt: new Date('2026-10-26T15:01:00Z'),
};
const observedAt = new Date('2026-10-26T15:30:00Z');

function signed(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const values = {
    vnp_TxnRef: intent.attemptId, vnp_Amount: '45000000', vnp_TmnCode: intent.merchantCode,
    vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: 'VN-123',
    vnp_PayDate: '20261026221459', ...overrides,
  };
  const fields = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Record<string, string>;
  const sorted = Object.keys(fields).sort().map(key =>
    `${key}=${encodeURIComponent(fields[key]).replace(/%20/g, '+')}`).join('&');
  return { ...fields, vnp_SecureHash: createHmac('sha512', secret).update(Buffer.from(sorted, 'utf-8')).digest('hex') };
}

describe('signed funded VNPay callback evidence', () => {
  it('parses a real ICT timestamp strictly', () => {
    expect(parseVnpayPaidAt('20261026221459')?.toISOString()).toBe('2026-10-26T15:14:59.000Z');
    for (const bad of ['', '202610262215', '20261026221500Z', '20260230000000', '20261026246000']) {
      expect(parseVnpayPaidAt(bad)).toBeNull();
    }
  });

  it('accepts the official signed IPN shape without CurrCode when paid during hold', () => {
    expect(evaluateSignedVoucherVnpayCallback(intent, signed(), secret, observedAt))
      .toMatchObject({ decision: 'SETTLE', providerReference: 'VN-123',
        providerPaidAt: new Date('2026-10-26T15:14:59Z') });
    expect(evaluateSignedVoucherVnpayCallback(intent,
      signed({ vnp_CurrCode: 'VND' }), secret, observedAt).decision).toBe('SETTLE');
  });

  it('quarantines missing or malformed signed pay date and paid time at the boundary', () => {
    for (const payDate of ['', '20260230000000', '20261026221500']) {
      expect(evaluateSignedVoucherVnpayCallback(intent, signed({ vnp_PayDate: payDate }), secret, observedAt).decision)
        .toBe('QUARANTINE');
    }
    const missing = signed({ vnp_PayDate: undefined });
    expect(evaluateSignedVoucherVnpayCallback(intent, missing, secret, observedAt).decision).toBe('QUARANTINE');
    expect(evaluateSignedVoucherVnpayCallback(intent,
      signed({ vnp_PayDate: '20261026221500' }), secret, observedAt)).toMatchObject({
      decision: 'QUARANTINE', providerReference: 'VN-123',
      providerPaidAt: new Date('2026-10-26T15:15:00Z'),
    });
  });

  it('quarantines tampering, wrong amount or attempt, and signed failure reporting paid funds', () => {
    const tampered = signed(); tampered.vnp_Amount = '1';
    expect(evaluateSignedVoucherVnpayCallback(intent, tampered, secret, observedAt).decision).toBe('QUARANTINE');
    expect(evaluateSignedVoucherVnpayCallback(intent, signed({ vnp_Amount: '50000000' }), secret, observedAt).decision)
      .toBe('QUARANTINE');
    expect(evaluateSignedVoucherVnpayCallback(intent, signed({ vnp_TxnRef: 'other' }), secret, observedAt).decision)
      .toBe('QUARANTINE');
    expect(evaluateSignedVoucherVnpayCallback(intent, signed({ vnp_TmnCode: 'OTHER' }), secret, observedAt).decision)
      .toBe('QUARANTINE');
    expect(evaluateSignedVoucherVnpayCallback(intent, signed({ vnp_CurrCode: 'USD' }), secret, observedAt).decision)
      .toBe('QUARANTINE');
    expect(evaluateSignedVoucherVnpayCallback(intent,
      signed({ vnp_ResponseCode: '24', vnp_TransactionStatus: '02' }), secret, observedAt).decision)
      .toBe('QUARANTINE');
    expect(evaluateSignedVoucherVnpayCallback(intent,
      signed({ vnp_ResponseCode: '00', vnp_TransactionStatus: '02', vnp_PayDate: undefined }), secret, observedAt).decision)
      .toBe('QUARANTINE');
  });

  it('releases on a matching signed terminal failure with no reported payment time', () => {
    expect(evaluateSignedVoucherVnpayCallback(intent,
      signed({ vnp_ResponseCode: '24', vnp_TransactionStatus: '02',
        vnp_PayDate: undefined }), secret, observedAt).decision).toBe('RELEASE');
  });

  it.each(['04', '05', '06', '07', '09', '10', '20', '99'])(
    'does not release capacity for signed non-terminal or unresolved status %s', status => {
      expect(evaluateSignedVoucherVnpayCallback(intent, signed({
        vnp_ResponseCode: '99', vnp_TransactionStatus: status, vnp_PayDate: undefined,
      }), secret, observedAt).decision).toBe('QUARANTINE');
    });

  it('never releases a response that reports a successful debit suspected of fraud', () => {
    expect(evaluateSignedVoucherVnpayCallback(intent, signed({
      vnp_ResponseCode: '07', vnp_TransactionStatus: '02', vnp_PayDate: undefined,
    }), secret, observedAt).decision).toBe('QUARANTINE');
  });

  it('retains an unfinished signed transaction until a terminal outcome arrives', () => {
    expect(evaluateSignedVoucherVnpayCallback(intent, signed({
      vnp_ResponseCode: '99', vnp_TransactionStatus: '01', vnp_PayDate: undefined,
    }), secret, observedAt).decision).toBe('KEEP_PENDING');
  });
});
