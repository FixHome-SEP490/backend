import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { CostItemType, PaymentAttemptStatus, PaymentMode, PaymentPurpose, PartSource } from '../../shared/enums';
import { Payment } from '../finance/entities/payment.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { VoucherCampaign, VoucherClaim, VoucherReservation } from './entities/voucher.entity';
import { VoucherFundingEntry, VoucherPaymentLink } from './entities/voucher-funding.entity';
import { VoucherDiscount } from './voucher.types';
import { bindVoucherPaymentLink } from './voucher-payment-link';
import { loadVoucherPreviewInvoices } from './voucher-checkout-preview';

vi.mock('./voucher-checkout-preview', () => ({ loadVoucherPreviewInvoices: vi.fn() }));

const now = new Date('2026-10-26T15:02:00Z');
const policy = { discount: VoucherDiscount.PERCENT, value: 50, capVnd: null,
  minimumVnd: 0, categoryIds: [], serviceIds: [], components: ['LABOR', 'PARTS'] as ['LABOR', 'PARTS'] };
const reservation = { id: 'reservation-1', claimId: 'claim-1', customerId: 'customer-1', scopeId: 'scope-1',
  campaignId: 'campaign-1',
  attemptId: 'attempt-1', state: 'RESERVED', policySnapshot: policy,
  checkoutSnapshot: { eligibleSubtotalVnd: 100 },
  reservedAt: new Date('2026-10-26T15:00:00Z'), expiresAt: new Date('2026-10-26T15:15:00Z') };
const facts = { invoices: [{ invoiceId: 'invoice-1', successful: true,
  originalGrossVnd: 100, laborTotalVnd: 100, fixHomePartsTotalVnd: 0,
  commissionRateSnapshot: 0.1, commissionAmountVnd: 10,
  originalPlatformDueVnd: 10, technicianEntitlementVnd: 90,
  items: [{ invoiceId: 'invoice-1', type: CostItemType.LABOR,
    partSource: PartSource.FIXHOME, quantity: 1, unitPriceVnd: 100, lineTotalVnd: 100 }] }],
  services: [{ serviceId: 'service-1', categoryId: 'category-1' }] };

describe('persisted voucher payment binding (no rail activation)', () => {
  let payment: any;
  let group: any;
  let groupPayment: any;
  let cash: any;
  let link: any;
  let pendingEntry: any;
  let manager: EntityManager;

  beforeEach(() => {
    vi.mocked(loadVoucherPreviewInvoices).mockResolvedValue(facts);
    link = null;
    pendingEntry = null;
    group = null;
    payment = { id: 'payment-1', invoiceId: 'invoice-1', amount: 50,
      purpose: PaymentPurpose.INVOICE, mode: PaymentMode.LIVE, status: PaymentAttemptStatus.PENDING,
      provider: 'vnpay', idempotencyKey: 'vnp-attempt-1',
      requestedByUserId: 'customer-1', requestedAt: new Date('2026-10-26T15:01:00Z') };
    groupPayment = null;
    cash = null;
    manager = {
      queryRunner: { isTransactionActive: true },
      findOne: vi.fn(async (entity: unknown) => entity === VoucherReservation ? reservation :
        entity === VoucherCampaign ? { id: 'campaign-1' } :
        entity === Payment ? payment : entity === VisitGroupPayment ? groupPayment :
          entity === CashSettlement ? cash : entity === VoucherPaymentLink ? link :
            entity === VoucherFundingEntry ? pendingEntry : null),
      findOneBy: vi.fn(async (entity: unknown, where: { id?: string }) => entity === VoucherClaim ?
        { id: 'claim-1', customerId: 'customer-1', policySnapshot: policy } :
        entity === VisitGroup ? group : entity === Invoice ?
          { id: where.id, serviceOrderId: 'order-1' } : null),
      create: vi.fn((_entity: unknown, value: unknown) => value),
      save: vi.fn(async (entity: unknown, value: unknown) => {
        if (entity === VoucherFundingEntry) {
          pendingEntry = { id: 'entry-1', ...(value as object) }; return pendingEntry;
        }
        link = { id: 'link-1', ...(value as object) }; return link;
      }),
      query: vi.fn(async () => [{ now }]),
    } as unknown as EntityManager;
  });

  it('refuses to bind a money source outside an active database transaction', async () => {
    (manager.queryRunner as { isTransactionActive: boolean }).isTransactionActive = false;
    await expect(bindVoucherPaymentLink(manager, 'reservation-1', 'VNPAY', 'payment-1')).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('binds a signed-provider attempt to the frozen due and retries without a second link', async () => {
    const first = await bindVoucherPaymentLink(manager, 'reservation-1', 'VNPAY', 'payment-1');
    const calls = vi.mocked(manager.findOne).mock.calls;
    const campaignLock = calls.findIndex(([entity, options]: any[]) => entity === VoucherCampaign &&
      options.lock?.mode === 'pessimistic_write');
    const reservationLock = calls.findIndex(([entity, options]: any[]) => entity === VoucherReservation &&
      options.lock?.mode === 'pessimistic_write');
    expect(campaignLock).toBeGreaterThanOrEqual(0);
    expect(campaignLock).toBeLessThan(reservationLock);
    expect(first).toMatchObject({ customerDueVnd: 50, subsidyVnd: 50,
      paymentId: 'payment-1', providerTxnRef: 'vnp-attempt-1' });
    expect(pendingEntry).toMatchObject({ kind: 'PROVIDER_PENDING', linkId: 'link-1',
      amountVnd: 0, evidenceSha256: first.allocationSha256 });
    expect(loadVoucherPreviewInvoices).toHaveBeenCalledWith(manager, 'customer-1', 'scope-1', true);
    expect(await bindVoucherPaymentLink(manager, 'reservation-1', 'VNPAY', 'payment-1')).toEqual(first);
    expect(manager.save).toHaveBeenCalledTimes(2);
    vi.mocked(manager.query).mockResolvedValue([{ now: reservation.expiresAt }] as never);
    payment.status = PaymentAttemptStatus.VERIFIED;
    expect(await bindVoucherPaymentLink(manager, 'reservation-1', 'VNPAY', 'payment-1')).toEqual(first);
    expect(manager.save).toHaveBeenCalledTimes(2);
    await expect(bindVoucherPaymentLink(manager, 'reservation-1', 'VNPAY', 'foreign-payment')).rejects.toThrow();
  });

  it('rejects mismatched payment amount or stale reservation before writing', async () => {
    payment.amount = 100;
    await expect(bindVoucherPaymentLink(manager, 'reservation-1', 'VNPAY', 'payment-1')).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
    payment.amount = 50;
    vi.mocked(manager.query).mockResolvedValue([{ now: reservation.expiresAt }] as never);
    await expect(bindVoucherPaymentLink(manager, 'reservation-1', 'VNPAY', 'payment-1')).rejects.toThrow();
  });

  it('binds a verified 0 VND settlement without a payment row', async () => {
    vi.mocked(loadVoucherPreviewInvoices).mockResolvedValue({ ...facts,
      invoices: [{ ...facts.invoices[0], originalGrossVnd: 100 }] });
    const full = { ...reservation, policySnapshot: { ...policy, value: 100 },
      checkoutSnapshot: { eligibleSubtotalVnd: 100 } };
    vi.mocked(manager.findOne).mockImplementation(async (entity: unknown) =>
      entity === VoucherReservation ? full as never :
        entity === VoucherCampaign ? { id: 'campaign-1' } as never :
          entity === VoucherPaymentLink ? link : null);
    const bound = await bindVoucherPaymentLink(manager, 'reservation-1', 'ZERO');
    expect(bound).toMatchObject({ rail: 'ZERO', customerDueVnd: 0,
      paymentId: null, visitGroupPaymentId: null });
  });

  it('checks VisitGroup child allocations against frozen discounted invoice due', async () => {
    group = { id: 'scope-1', customerId: 'customer-1' };
    groupPayment = { id: 'visit-payment-1', visitGroupId: 'scope-1', rail: 'vnpay',
      status: 'pending', amount: 50,
      allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1', amount: 50 }],
      requestedByUserId: 'customer-1', idempotencyKey: 'group-vnp-1',
      requestedAt: new Date('2026-10-26T15:01:00Z') };
    expect(await bindVoucherPaymentLink(manager, 'reservation-1', 'VNPAY', 'visit-payment-1'))
      .toMatchObject({ scopeKind: 'VISIT_GROUP', visitGroupPaymentId: 'visit-payment-1' });
    link = null;
    groupPayment.allocations[0].amount = 100;
    await expect(bindVoucherPaymentLink(manager, 'reservation-1', 'VNPAY', 'visit-payment-1')).rejects.toThrow();
  });

  it('binds solo cash to a technician declaration only while awaiting customer confirmation', async () => {
    cash = { id: 'cash-1', serviceOrderId: 'scope-1', status: 'pending_confirmation',
      declaredAmount: 50, declaredAt: new Date('2026-10-26T15:01:00Z') };
    expect(await bindVoucherPaymentLink(manager, 'reservation-1', 'CASH', 'cash-1'))
      .toMatchObject({ rail: 'CASH', cashSettlementId: 'cash-1', customerDueVnd: 50 });
    link = null;
    cash.status = 'disputed';
    await expect(bindVoucherPaymentLink(manager, 'reservation-1', 'CASH', 'cash-1')).rejects.toThrow();
  });
});
