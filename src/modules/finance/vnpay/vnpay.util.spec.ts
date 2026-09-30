import { describe, expect, it } from 'vitest';
import { buildPaymentUrl, formatVnpayDate, verifySignature } from './vnpay.util';

describe('vnpay.util', () => {
  const hashSecret = 'TESTSECRET123';

  it('stamps dates in Vietnam time whatever zone the server runs in', () => {
    // A Docker image runs in UTC; VNPay reads these fields as GMT+7.
    expect(formatVnpayDate(new Date('2026-01-01T03:00:00Z'))).toBe('20260101100000');
    expect(formatVnpayDate(new Date('2026-12-31T17:05:09Z'))).toBe('20270101000509');
  });

  it('builds a URL whose query verifies against the same secret', () => {
    const url = buildPaymentUrl({
      paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
      tmnCode: 'TMNCODE01',
      hashSecret,
      amount: 150000,
      txnRef: 'abc123',
      orderInfo: 'Thanh toan hoa don abc123',
      returnUrl: 'http://localhost:3000/finance/vnpay/return',
      ipAddr: '127.0.0.1',
      createdAt: new Date('2026-01-01T10:00:00'),
    });
    const query = Object.fromEntries(new URL(url).searchParams.entries());
    expect(query.vnp_Amount).toBe('15000000');
    expect(verifySignature(query, hashSecret)).toBe(true);
  });

  it('rejects a tampered amount', () => {
    const url = buildPaymentUrl({
      paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
      tmnCode: 'TMNCODE01',
      hashSecret,
      amount: 150000,
      txnRef: 'abc123',
      orderInfo: 'Thanh toan hoa don abc123',
      returnUrl: 'http://localhost:3000/finance/vnpay/return',
      ipAddr: '127.0.0.1',
    });
    const query = Object.fromEntries(new URL(url).searchParams.entries());
    query.vnp_Amount = '1';
    expect(verifySignature(query, hashSecret)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const url = buildPaymentUrl({
      paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
      tmnCode: 'TMNCODE01',
      hashSecret,
      amount: 150000,
      txnRef: 'abc123',
      orderInfo: 'x',
      returnUrl: 'http://localhost:3000/finance/vnpay/return',
      ipAddr: '127.0.0.1',
    });
    const query = Object.fromEntries(new URL(url).searchParams.entries());
    expect(verifySignature(query, 'WRONGSECRET')).toBe(false);
  });
});
