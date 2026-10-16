import { describe, expect, it } from 'vitest';
import { buildPaymentUrl, formatVnpayDate, pickWebOrigin, verifySignature, withWebOrigin } from './vnpay.util';

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

  it('verifies a return that carries our own web marker beside the vnp_ fields', () => {
    const url = buildPaymentUrl({
      paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
      tmnCode: 'TMNCODE01',
      hashSecret,
      amount: 150000,
      txnRef: 'abc123',
      orderInfo: 'x',
      returnUrl: withWebOrigin('https://api.fixhome.sbs/api/v1/finance/vnpay/return', 'http://localhost:5173'),
      ipAddr: '127.0.0.1',
    });
    const query = Object.fromEntries(new URL(url).searchParams.entries());
    expect(new URL(query.vnp_ReturnUrl).searchParams.get('web')).toBe('http://localhost:5173');
    // VNPay sends the browser back with our `web` beside its own signed fields.
    expect(verifySignature({ ...query, web: 'http://localhost:5173' }, hashSecret)).toBe(true);
    expect(verifySignature({ ...query, web: 'https://evil.example', vnp_Amount: '1' }, hashSecret)).toBe(false);
  });

  it('leaves the return URL alone when there is no web origin', () => {
    expect(withWebOrigin('https://api.fixhome.sbs/api/v1/finance/vnpay/return')).toBe('https://api.fixhome.sbs/api/v1/finance/vnpay/return');
  });

  describe('pickWebOrigin', () => {
    const allowed = 'http://localhost:5173, https://fixhome.sbs,https://www.fixhome.sbs/';
    const fallback = 'https://fixhome.sbs';

    it('sends local dev back to local and the deployed site back to itself', () => {
      expect(pickWebOrigin('http://localhost:5173', allowed, fallback)).toBe('http://localhost:5173');
      expect(pickWebOrigin('https://www.fixhome.sbs', allowed, fallback)).toBe('https://www.fixhome.sbs');
    });

    it('never redirects to an address outside the allowed origins', () => {
      for (const bad of ['https://evil.example', 'http://localhost:5173.evil.example', 'https://fixhome.sbs.evil.example', 'https://fixhome.sbs/phish', 'javascript:alert(1)', 'not a url', '']) {
        expect(pickWebOrigin(bad, allowed, fallback)).toBe(fallback);
      }
      expect(pickWebOrigin(undefined, allowed, fallback)).toBe(fallback);
    });
  });
});

