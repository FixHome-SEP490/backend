import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from './finance.service';

describe('legacy optional funded link compatibility', () => {
  function fixture(error?: unknown) {
    const findOne = vi.fn(error ? async () => { throw error; } : async () => ({ reservationId: 'held' }));
    const dataSource = { getRepository: vi.fn(() => ({ findOne })) };
    const service = Object.create(FinanceService.prototype) as {
      findOptionalVoucherPaymentLink: (where: { paymentId: string }) => Promise<unknown>;
    };
    Object.assign(service, { dataSource });
    return { service, findOne };
  }

  it('reads the linked reservation when funding schema is present', async () => {
    const { service, findOne } = fixture();
    await expect(service.findOptionalVoucherPaymentLink({ paymentId: 'p1' })).resolves.toEqual({ reservationId: 'held' });
    expect(findOne).toHaveBeenCalledWith({ where: { paymentId: 'p1' } });
  });

  it('allows legacy money only when exactly the additive link relation is missing', async () => {
    const { service } = fixture({ driverError: { code: '42P01', message: 'relation "member1_e2e_123.voucher_payment_links" does not exist' } });
    await expect(service.findOptionalVoucherPaymentLink({ paymentId: 'p1' })).resolves.toBeNull();
  });

  it.each([
    { driverError: { code: '42P01', message: 'relation "public.payments" does not exist' } },
    { driverError: { code: '42501', message: 'permission denied for voucher_payment_links' } },
    { driverError: { code: '08006', message: 'connection failure' } },
  ])('never hides other database failures', async error => {
    const { service } = fixture(error);
    await expect(service.findOptionalVoucherPaymentLink({ paymentId: 'p1' })).rejects.toEqual(error);
  });
});
