import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from './finance.service';

function fixture() {
  const query = vi.fn(async () => [{ ready: true }]);
  const service = Object.assign(Object.create(FinanceService.prototype), {
    dataSource: { query }, vouchersService: {}, walletService: {},
    customerWalletService: {}, settlementService: {},
  }) as FinanceService;
  return { service, query };
}

describe('funded collection readiness', () => {
  it('opens only with applied additive migration, schema access and money dependencies', async () => {
    const { service, query } = fixture();
    await expect((service as any).assertFundedCollectionReady()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([false, null, 'true', undefined])('fails closed for unproven schema readiness %s', async ready => {
    const { service, query } = fixture();
    query.mockResolvedValueOnce([{ ready }] as never);
    await expect((service as any).assertFundedCollectionReady())
      .rejects.toMatchObject({ response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' } });
  });
  it('rejects an unapplied migration even if tables are present', async () => {
    const { service, query } = fixture();
    query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([{ ready: false }]);
    await expect((service as any).assertFundedCollectionReady())
      .rejects.toMatchObject({ response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' } });
  });
  it.each(['vouchersService', 'walletService', 'customerWalletService', 'settlementService'])(
    'rejects missing %s before querying the database', async name => {
      const { service, query } = fixture();
      Object.assign(service, { [name]: undefined });
      await expect((service as any).assertFundedCollectionReady())
        .rejects.toMatchObject({ response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' } });
      expect(query).not.toHaveBeenCalled();
    });
  it('maps database failure to an unavailable response without leaking SQL', async () => {
    const { service, query } = fixture();
    query.mockRejectedValueOnce(new Error('sensitive database diagnostics'));
    await expect((service as any).assertFundedCollectionReady())
      .rejects.toMatchObject({ response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' } });
  });
});
