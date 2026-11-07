import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { PartRequestType, PartUsageStatus, PaymentStatus, WalletTransactionType, WarrantyStatus } from '../../shared/enums';
import { WarrantyCostService } from './warranty-cost.service';

const CLAIM = { id: 'claim-1', serviceOrderId: 'order-1', warrantyCoverageId: 'cov-1', technicianId: 'tech-2', declinedByTechnicianId: 'tech-9' } as any;

const make = (options: { paid?: boolean; grandTotal?: number; refunded?: number; line?: unknown; funded?: boolean; charged?: boolean } = {}) => {
  const entities: Record<string, unknown> = {
    ServiceOrder: { id: 'order-1', code: 'SO-1', bookingId: 'booking-1' },
    WarrantyCoverage: { id: 'cov-1', invoiceItemId: 'line-1' },
    InvoiceItem: 'line' in options ? options.line : { id: 'line-1', lineTotal: '300000' },
    Booking: { id: 'booking-1', customerId: 'customer-1' },
    WalletTransaction: options.charged === false ? null : { id: 'tx-1' },
  };
  const manager: any = {
    findOneBy: vi.fn(async (entity: { name: string }) => entities[entity.name] ?? null),
    findOne: vi.fn(async (entity: { name: string }) => {
      if (entity.name === 'Invoice') {
        return { id: 'inv-1', paymentStatus: options.paid === false ? PaymentStatus.UNPAID : PaymentStatus.PAID, grandTotal: String(options.grandTotal ?? 500_000) };
      }
      if (entity.name === 'TechnicianAssignment') return { technicianId: 'tech-1' };
      return entities[entity.name] ?? null;
    }),
    find: vi.fn(async () => []),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
    query: vi.fn(async () => (options.funded ? [{ rel: 'voucher_payment_links' }] : [{ rel: null }])),
  };
  const walletService = {
    getOrCreateWallet: vi.fn(async (technicianId: string) => ({ id: `wallet-of-${technicianId}` })),
    mutateBalance: vi.fn().mockResolvedValue({}),
  };
  const customerWallet = { refundedForOrder: vi.fn().mockResolvedValue(options.refunded ?? 0), apply: vi.fn().mockResolvedValue({}) };
  const reputation = { penalizeWarranty: vi.fn().mockResolvedValue(null) };
  const config = { getInt: vi.fn(async (_key: string, fallback: number) => fallback) };
  const service = new WarrantyCostService(walletService as any, customerWallet as any, reputation as any, config as any);
  return { service, manager, walletService, customerWallet, reputation, config };
};

const request = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'pr-1', technicianId: 'tech-2', warrantyClaimId: 'claim-1', requestType: PartRequestType.WARRANTY, chargeTechnician: true,
    items: [
      { id: 'it-1', quantity: 2, unitPriceSnapshot: 150_000, usageStatus: PartUsageStatus.PENDING },
      { id: 'it-2', quantity: 1, unitPriceSnapshot: 100_000, usageStatus: PartUsageStatus.PENDING },
    ],
    ...overrides,
  }) as any;

describe('settleUnfixed', () => {
  it('refunds the customer wallet and charges the original technician the same amount, defaulting to the covered line', async () => {
    const { service, manager, walletService, customerWallet } = make();

    const refund = await service.settleUnfixed(manager, CLAIM);

    expect(refund).toBe(300_000);
    expect(customerWallet.apply).toHaveBeenCalledWith(manager, expect.objectContaining({
      userId: 'customer-1', type: 'refund', amount: 300_000, idempotencyKey: 'REFUND:WARRANTY_claim-1', referenceId: 'order-1',
    }));
    // The technician who did the job pays, not the one who failed the re-service.
    expect(walletService.getOrCreateWallet).toHaveBeenCalledWith('tech-1', manager);
    expect(walletService.mutateBalance).toHaveBeenCalledWith(expect.objectContaining({
      walletId: 'wallet-of-tech-1', type: WalletTransactionType.ADJUSTMENT, debit: true, amount: 300_000,
      allowNegative: true, idempotencyKey: 'WARRANTY_CHARGE:claim-1:UNFIXED', referenceType: 'WARRANTY_CLAIM', referenceId: 'claim-1',
    }));
  });

  it('refunds the amount the manager chose and keeps the coverage when only part of the invoice is refunded', async () => {
    const { service, manager, customerWallet } = make();

    expect(await service.settleUnfixed(manager, CLAIM, 120_000)).toBe(120_000);

    expect(customerWallet.apply).toHaveBeenCalledWith(manager, expect.objectContaining({ amount: 120_000 }));
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('voids the warranty once the whole invoice has been refunded', async () => {
    const { service, manager } = make({ refunded: 200_000 });

    await service.settleUnfixed(manager, CLAIM);

    expect(manager.update).toHaveBeenCalledWith(expect.anything(), { serviceOrderId: 'order-1' }, { status: WarrantyStatus.VOIDED });
  });

  it('refuses an unpaid order, a refund above what the customer paid, a bad amount and a voucher funded invoice', async () => {
    const unpaid = make({ paid: false });
    await expect(unpaid.service.settleUnfixed(unpaid.manager, CLAIM)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });

    const tooMuch = make({ refunded: 300_000 });
    await expect(tooMuch.service.settleUnfixed(tooMuch.manager, CLAIM, 250_000)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
    expect(tooMuch.customerWallet.apply).not.toHaveBeenCalled();

    for (const amount of [0, -5, 1.5]) {
      const bad = make();
      await expect(bad.service.settleUnfixed(bad.manager, CLAIM, amount)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
    }

    const noLine = make({ line: null });
    await expect(noLine.service.settleUnfixed(noLine.manager, CLAIM)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });

    const funded = make({ funded: true });
    await expect(funded.service.settleUnfixed(funded.manager, CLAIM)).rejects.toThrow();
    expect(funded.customerWallet.apply).not.toHaveBeenCalled();
    expect(funded.walletService.mutateBalance).not.toHaveBeenCalled();
  });

  it('does not charge anyone when the order never had a technician', async () => {
    const { service, manager, walletService } = make();
    manager.findOne.mockImplementation(async (entity: { name: string }) =>
      entity.name === 'Invoice' ? { id: 'inv-1', paymentStatus: PaymentStatus.PAID, grandTotal: '500000' } : null);

    await service.settleUnfixed(manager, { ...CLAIM, technicianId: null });

    expect(walletService.mutateBalance).not.toHaveBeenCalled();
  });
});

describe('a part caused by the technician', () => {
  it('is charged at its selling price once the manager finds an installation fault, once', async () => {
    const { service, manager, walletService } = make();

    await service.chargeForInstallation(manager, request());

    expect(walletService.mutateBalance).toHaveBeenCalledWith(expect.objectContaining({
      walletId: 'wallet-of-tech-2', type: WalletTransactionType.ADJUSTMENT, debit: true, amount: 400_000,
      allowNegative: true, idempotencyKey: 'WARRANTY_PART:pr-1', referenceId: 'claim-1',
    }));
    expect(manager.update).toHaveBeenCalledWith(expect.anything(), 'pr-1', { faultyReturnChargedAt: expect.any(Date) });
  });

  it('is never charged for a fault that is not the installation, a non-warranty request, or a part that costs nothing', async () => {
    const { service, manager, walletService } = make();

    await service.chargeForInstallation(manager, request({ chargeTechnician: false }));
    await service.chargeForInstallation(manager, request({ requestType: PartRequestType.ADDITIONAL }));
    await service.chargeForInstallation(manager, request({ items: [{ id: 'it-1', quantity: 1, unitPriceSnapshot: 0 }] }));

    expect(walletService.mutateBalance).not.toHaveBeenCalled();
  });

  it('starts a deadline for bringing the faulty part back when the replacement is received', async () => {
    const { service, manager, config } = make();
    const row = request();
    config.getInt.mockResolvedValue(5);

    await service.startReturnClock(manager, row);

    expect(config.getInt).toHaveBeenCalledWith('warranty.faulty_return_days', 7);
    const days = (row.faultyReturnDueAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(4.99);
    expect(days).toBeLessThan(5.01);
    const other = make();
    await other.service.startReturnClock(other.manager, request({ requestType: PartRequestType.ADDITIONAL }));
    expect(other.manager.update).not.toHaveBeenCalled();
  });

  it('is charged when the faulty part is overdue, under the same key as an installation charge so it never doubles', async () => {
    const { service, manager, walletService } = make();

    await service.chargeUnreturned(manager, request({ chargeTechnician: false }));

    expect(walletService.mutateBalance).toHaveBeenCalledWith(expect.objectContaining({
      debit: true, amount: 400_000, allowNegative: true, idempotencyKey: 'WARRANTY_PART:pr-1',
    }));
  });

  it('gives an overdue charge back, once, when the manager finds it was not the installation', async () => {
    const { service, manager, walletService } = make();
    const charged = request({ chargeTechnician: false, faultyReturnChargedAt: new Date() });

    await service.refundUnreturned(manager, charged);

    expect(walletService.mutateBalance).toHaveBeenCalledWith(expect.objectContaining({
      type: WalletTransactionType.ADJUSTMENT, amount: 400_000, idempotencyKey: 'WARRANTY_PART_REFUND:pr-1',
    }));
    expect(walletService.mutateBalance.mock.calls[0][0].debit).toBeUndefined();

    const installation = make();
    await installation.service.refundUnreturned(installation.manager, request({ chargeTechnician: true, faultyReturnChargedAt: new Date() }));
    const neverCharged = make();
    await neverCharged.service.refundUnreturned(neverCharged.manager, request({ chargeTechnician: false }));
    expect(installation.walletService.mutateBalance).not.toHaveBeenCalled();
    expect(neverCharged.walletService.mutateBalance).not.toHaveBeenCalled();
  });

  it('is credited back for a returned item only if it was charged', async () => {
    const { service, manager, walletService } = make();
    const item = { id: 'it-1', quantity: 2, unitPriceSnapshot: 150_000, usageStatus: PartUsageStatus.RETURNED } as any;

    await service.creditReturned(manager, request(), item);

    expect(walletService.mutateBalance).toHaveBeenCalledWith(expect.objectContaining({
      walletId: 'wallet-of-tech-2', type: WalletTransactionType.ADJUSTMENT, amount: 300_000, idempotencyKey: 'WARRANTY_PART_RETURN:it-1',
    }));
    expect(walletService.mutateBalance.mock.calls[0][0].debit).toBeUndefined();

    const notCharged = make({ charged: false });
    await notCharged.service.creditReturned(notCharged.manager, request(), item);
    expect(notCharged.walletService.mutateBalance).not.toHaveBeenCalled();

    const used = make();
    await used.service.creditReturned(used.manager, request(), { ...item, usageStatus: PartUsageStatus.USED });
    expect(used.walletService.mutateBalance).not.toHaveBeenCalled();
  });
});

describe('penalize', () => {
  it('penalizes the technician recorded at the decline or no-show, and the claim technician for an unfixed claim', async () => {
    const { service, manager, reputation } = make();

    await service.penalize(manager, CLAIM, 'decline', 'sm-1', 'từ chối');
    await service.penalize(manager, CLAIM, 'no_show', 'sm-1', 'vắng mặt');
    await service.penalize(manager, CLAIM, 'unfixed', 'sm-1', 'không sửa được');

    expect(reputation.penalizeWarranty.mock.calls.map(([, input]) => [input.cause, input.technicianId])).toEqual([
      ['decline', 'tech-9'], ['no_show', 'tech-9'], ['unfixed', 'tech-2'],
    ]);
  });

  it('skips when nobody is to blame', async () => {
    const { service, manager, reputation } = make();
    await service.penalize(manager, { ...CLAIM, technicianId: null, declinedByTechnicianId: null }, 'unfixed', 'sm-1', 'x');
    await service.penalize(manager, { ...CLAIM, declinedByTechnicianId: null }, 'decline', 'sm-1', 'x');
    expect(reputation.penalizeWarranty).not.toHaveBeenCalled();
  });
});
