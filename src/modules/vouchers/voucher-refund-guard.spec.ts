import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { assertNoFundedVoucherRefund } from './voucher-refund-guard';

describe('legacy refund boundary for funded invoices', () => {
  it('refuses the original-gross refund path whenever an invoice has a voucher link', async () => {
    const manager = { query: vi.fn().mockResolvedValue([{ id: 'link-1' }]) } as unknown as EntityManager;
    await expect(assertNoFundedVoucherRefund(manager, 'invoice-1')).rejects.toThrow();
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('allocation_snapshot @>'),
      [JSON.stringify([{ invoiceId: 'invoice-1' }])]);
  });

  it('allows legacy invoices and a pre-migration deployment, but fails on unknown DB errors', async () => {
    const manager = { query: vi.fn().mockResolvedValue([]) } as unknown as EntityManager;
    await expect(assertNoFundedVoucherRefund(manager, 'invoice-1')).resolves.toBeUndefined();
    vi.mocked(manager.query).mockRejectedValueOnce({ driverError: { code: '42P01' } });
    await expect(assertNoFundedVoucherRefund(manager, 'invoice-1')).resolves.toBeUndefined();
    vi.mocked(manager.query).mockRejectedValueOnce({ code: '42P01' });
    await expect(assertNoFundedVoucherRefund(manager, 'invoice-1')).resolves.toBeUndefined();
    vi.mocked(manager.query).mockRejectedValueOnce({ driverError: { code: '42501' } });
    await expect(assertNoFundedVoucherRefund(manager, 'invoice-1')).rejects.toThrow();
  });
});
