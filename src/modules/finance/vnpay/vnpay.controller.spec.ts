import { describe, expect, it, vi } from 'vitest';
import { PaymentPurpose } from '../../../shared/enums';
import { VnpayController } from './vnpay.controller';

const ENV: Record<string, string> = {
  CORS_ORIGIN: 'http://localhost:5173,https://fixhome.sbs',
  FRONTEND_URL: 'https://fixhome.sbs',
};

function returnTo(web: string | undefined, payerRole = 'customer') {
  const finance = {
    handleVnpayReturn: vi.fn().mockResolvedValue({ ok: true, purpose: PaymentPurpose.WALLET_TOP_UP, amount: 100000, payerRole, orderInfo: 'Nap vi' }),
  };
  const config = { get: (key: string, fallback?: string) => ENV[key] ?? fallback };
  const controller = new VnpayController(finance as never, config as never);
  const res = { redirect: vi.fn() };
  const query: Record<string, string> = { vnp_ResponseCode: '00', vnp_TxnRef: 'T1' };
  if (web !== undefined) query.web = web;
  return controller.returnUrl(query, res as never).then(() => res.redirect.mock.calls[0][0] as string);
}

describe('VNPay return sends the browser back to its own site', () => {
  it('local dev returns to local, the deployed web to itself', async () => {
    expect(await returnTo('http://localhost:5173')).toBe('http://localhost:5173/app/wallet?payment=success&amount=100000');
    expect(await returnTo('https://fixhome.sbs', 'technician')).toBe('https://fixhome.sbs/tech/wallet?payment=success&amount=100000');
  });

  it('falls back to FRONTEND_URL for a missing or foreign origin', async () => {
    expect(await returnTo(undefined)).toBe('https://fixhome.sbs/app/wallet?payment=success&amount=100000');
    expect(await returnTo('https://evil.example')).toBe('https://fixhome.sbs/app/wallet?payment=success&amount=100000');
  });
});
