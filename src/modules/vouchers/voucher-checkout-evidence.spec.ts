import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { RepairFailureVoucherEvidence } from './repair-failure-voucher-evidence';
import { loadVoucherPreviewInvoices } from './voucher-checkout-preview';
import { Payment } from '../finance/entities/payment.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { VoucherPaymentLink } from './entities/voucher-funding.entity';
import { VoucherCampaign, VoucherReservation } from './entities/voucher.entity';

vi.mock('./voucher-checkout-preview', () => ({ loadVoucherPreviewInvoices: vi.fn() }));

function fixture() {
  vi.mocked(loadVoucherPreviewInvoices).mockResolvedValue({
    invoices: [{ invoiceId: 'invoice-1', laborTotalVnd: 100000, fixHomePartsTotalVnd: 30000 }] as never,
    services: [{ categoryId: 'category-1', serviceId: 'service-1' }],
  });
  const manager = { queryRunner: { isTransactionActive: true }, exists: vi.fn(async (_entity: unknown, _options: any) => false),
    query: vi.fn(async () => [{ ready: true }]),
    findOne: vi.fn(async (entity: unknown) => entity === VoucherReservation
      ? { id: 'reservation-1', campaignId: 'campaign-1', customerId: 'customer-1', scopeId: 'scope-1', state: 'RESERVED' }
      : entity === VoucherCampaign ? { id: 'campaign-1' } : null) };
  return { manager, evidence: new RepairFailureVoucherEvidence() };
}

describe('authoritative voucher checkout evidence', () => {
  it('builds reservable facts from locked frozen invoices without changing money', async () => {
    const { manager, evidence } = fixture();
    const facts = await evidence.checkout(manager as unknown as EntityManager, 'customer-1', 'scope-1');
    expect(facts).toMatchObject({ customerId: 'customer-1', scopeId: 'scope-1',
      finalized: true, paymentState: 'NOT_STARTED', eligibleSubtotalVnd: 130000,
      items: [{ categoryId: 'category-1', serviceId: 'service-1' }] });
    expect(facts.snapshotId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(loadVoucherPreviewInvoices).toHaveBeenCalledWith(manager, 'customer-1', 'scope-1', true);
  });

  it.each([Payment, CashSettlement, VisitGroupPayment])('refuses an unresolved %s before reserving', async entity => {
    const { manager, evidence } = fixture();
    manager.exists.mockImplementation(async candidate => candidate === entity);
    await expect(evidence.checkout(manager as unknown as EntityManager, 'customer-1', 'scope-1'))
      .rejects.toMatchObject({ status: 409 });
  });

  it('requires the caller transaction before reading a checkout', async () => {
    const { manager, evidence } = fixture();
    manager.queryRunner.isTransactionActive = false;
    vi.mocked(loadVoucherPreviewInvoices).mockClear();
    await expect(evidence.checkout(manager as unknown as EntityManager, 'customer-1', 'scope-1'))
      .rejects.toMatchObject({ status: 409 });
    expect(loadVoucherPreviewInvoices).not.toHaveBeenCalled();
  });

  it('refuses to reserve until the additive funding migration is ready', async () => {
    const { manager, evidence } = fixture();
    manager.query.mockResolvedValueOnce([{ ready: false }]);
    vi.mocked(loadVoucherPreviewInvoices).mockClear();
    await expect(evidence.checkout(manager as unknown as EntityManager, 'customer-1', 'scope-1'))
      .rejects.toMatchObject({ response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' } });
    expect(loadVoucherPreviewInvoices).not.toHaveBeenCalled();
  });

  it.each([Payment, VisitGroupPayment])('rejects an old %s attempt whose failed status does not prove money returned', async entity => {
    const { manager, evidence } = fixture();
    const row: Record<string, unknown> = { invoiceId: 'invoice-1', visitGroupId: 'scope-1',
      status: 'failed', failureCode: 'ALLOCATION_CHANGED', providerReference: 'provider-paid-1' };
    manager.exists.mockImplementation(async (candidate, options) => candidate === entity &&
      Object.entries(options.where).every(([key, value]: [string, any]) =>
        value?.type === 'in' ? value.value.includes(row[key]) : row[key] === value));
    await expect(evidence.checkout(manager as unknown as EntityManager, 'customer-1', 'scope-1'))
      .rejects.toMatchObject({ status: 409 });
  });

  it('releases an abandoned reservation only after proving checkout has no collection', async () => {
    const { manager, evidence } = fixture();
    expect(await evidence.canRelease(manager as unknown as EntityManager, 'reservation-1')).toBe(true);
    expect(loadVoucherPreviewInvoices).toHaveBeenCalledWith(manager, 'customer-1', 'scope-1', true);
    manager.exists.mockResolvedValue(true);
    expect(await evidence.canRelease(manager as unknown as EntityManager, 'reservation-1')).toBe(false);
  });

  it('never releases a linked cash collection merely because the hold elapsed', async () => {
    const { manager, evidence } = fixture();
    const previous = manager.findOne.getMockImplementation()!;
    manager.findOne.mockImplementation(async entity => entity === VoucherPaymentLink
      ? { rail: 'CASH' } as never : previous(entity));
    vi.mocked(loadVoucherPreviewInvoices).mockClear();
    expect(await evidence.canRelease(manager as unknown as EntityManager, 'reservation-1')).toBe(false);
    expect(loadVoucherPreviewInvoices).not.toHaveBeenCalled();
  });
});
