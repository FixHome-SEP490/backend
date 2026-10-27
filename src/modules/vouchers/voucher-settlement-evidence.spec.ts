import { voucherAllocationDigest } from './voucher-allocation-digest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { CashSettlementStatus, PaymentAttemptStatus, PaymentMode, PaymentPurpose, PaymentStatus, WalletTransactionType } from '../../shared/enums';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { Payment } from '../finance/entities/payment.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VoucherFundingEntry, VoucherPaymentLink } from './entities/voucher-funding.entity';
import { VoucherCampaign, VoucherReservation } from './entities/voucher.entity';
import { commitVerifiedVoucherFunding, loadVoucherSettlementFacts } from './voucher-settlement-evidence';

describe('trusted voucher settlement evidence', () => {
  let manager: EntityManager;
  let link: any;
  let reservation: any;
  let payment: any;
  let invoice: any;
  let booking: any;
  let entries: any[];

  beforeEach(() => {
    const allocation = { invoiceId: 'invoice-1', originalGrossVnd: 100,
      eligibleBaseVnd: 100, subsidyVnd: 50, customerDueVnd: 50,
      originalPlatformDueVnd: 10, technicianEntitlementVnd: 90,
      commissionRateSnapshot: 0.1, commissionAmountVnd: 10 };
    reservation = { id: 'reservation-1', campaignId: 'campaign-1',
      attemptId: 'attempt-1', state: 'RESERVED',
      customerId: 'customer-1', scopeId: 'order-1', reservedAt: new Date('2026-10-26T15:00:00Z'),
      expiresAt: new Date('2026-10-26T15:15:00Z'),
      checkoutSnapshot: { snapshotId: 'snapshot-1', eligibleSubtotalVnd: 100 } };
    link = { id: 'link-1', reservationId: reservation.id, attemptId: reservation.attemptId,
      customerId: reservation.customerId, scopeId: reservation.scopeId, scopeKind: 'SOLO',
      rail: 'VNPAY', paymentId: 'payment-1', cashSettlementId: null,
      visitGroupPaymentId: null, providerTxnRef: 'provider-attempt-1',
      providerInitiatedAt: new Date('2026-10-26T15:01:00Z'),
      originalGrossVnd: 100, eligibleBaseVnd: 100, subsidyVnd: 50, customerDueVnd: 50,
      allocationSnapshot: [allocation],
      allocationSha256: voucherAllocationDigest([allocation]) };
    payment = { id: 'payment-1', invoiceId: 'invoice-1', purpose: PaymentPurpose.INVOICE,
      mode: PaymentMode.LIVE, currency: 'VND', provider: 'vnpay',
      status: PaymentAttemptStatus.VERIFIED, amount: 50, requestedByUserId: 'customer-1',
      idempotencyKey: 'provider-attempt-1', providerReference: 'VN-123',
      requestedAt: new Date('2026-10-26T15:01:00Z'),
      verifiedAt: new Date('2026-10-26T15:30:00Z') };
    invoice = { id: 'invoice-1', serviceOrderId: 'order-1', grandTotal: 100,
      laborTotal: 100, fixHomePartsTotal: 0, shippingFee: 0,
      commissionAmount: 10, commissionRateSnapshot: 0.1,
      paymentStatus: PaymentStatus.PAID, paidAt: payment.verifiedAt };
    booking = { id: 'booking-1', customerId: 'customer-1', visitGroupId: null };
    entries = [
      { linkId: link.id, kind: 'PROVIDER_PENDING', invoiceId: null,
        amountVnd: 0, evidenceSha256: link.allocationSha256 },
      { linkId: link.id, kind: 'PROVIDER_PAID', invoiceId: null,
        amountVnd: 0, providerReference: 'VN-123',
        providerPaidAt: new Date('2026-10-26T15:14:59Z'), evidenceSha256: 'b'.repeat(64) },
      { linkId: link.id, kind: 'SUBSIDY_COMMITTED', invoiceId: invoice.id,
        amountVnd: 50, evidenceSha256: link.allocationSha256 },
    ];
    manager = {
      queryRunner: { isTransactionActive: true },
      findOne: vi.fn(async (entity: unknown) => entity === VoucherPaymentLink ? link :
        entity === VoucherReservation ? reservation :
          entity === VoucherCampaign ? { id: 'campaign-1' } : entity === Payment ? payment :
          entity === Invoice ? invoice : entity === ServiceOrder ?
            { id: 'order-1', bookingId: booking.id } : entity === Booking ? booking : null),
      find: vi.fn(async (entity: unknown) => entity === VoucherFundingEntry ? entries : []),
      create: vi.fn((_entity: unknown, value: unknown) => value),
      save: vi.fn(async (_entity: unknown, value: any) => {
        const saved = { id: `entry-${entries.length}`, ...value }; entries.push(saved); return saved;
      }),
    } as unknown as EntityManager;
  });

  it('accepts a late signed provider payment against paid invoice and committed subsidy', async () => {
    expect(await loadVoucherSettlementFacts(manager, 'payment-1')).toEqual({
      settlementId: 'payment-1', reservationId: reservation.id, customerId: reservation.customerId,
      scopeId: reservation.scopeId, snapshotId: 'snapshot-1', status: 'SETTLED',
      settledAt: payment.verifiedAt,
    });
  });

  it('verifies a snapshot after jsonb reorders object keys, but rejects changed money', async () => {
    link.allocationSnapshot = link.allocationSnapshot.map((row: object) =>
      Object.fromEntries(Object.entries(row).reverse()));
    expect((await loadVoucherSettlementFacts(manager, payment.id)).status).toBe('SETTLED');
    link.allocationSnapshot[0].customerDueVnd += 1;
    await expect(loadVoucherSettlementFacts(manager, payment.id)).rejects.toThrow();
  });

  it('locks campaign before reservation and link for paid settlement evidence', async () => {
    await loadVoucherSettlementFacts(manager, payment.id);
    const calls = vi.mocked(manager.findOne).mock.calls;
    const index = (entity: unknown, mode: string) => calls.findIndex(
      ([called, options]: any[]) => called === entity && options.lock?.mode === mode);
    expect(index(VoucherCampaign, 'pessimistic_write')).toBeGreaterThanOrEqual(0);
    expect(index(VoucherCampaign, 'pessimistic_write'))
      .toBeLessThan(index(VoucherReservation, 'pessimistic_write'));
    expect(index(VoucherReservation, 'pessimistic_write'))
      .toBeLessThan(index(VoucherPaymentLink, 'pessimistic_read'));
  });

  it('writes company funding only after verified paid source, once per frozen invoice', async () => {
    entries = entries.filter(entry => entry.kind !== 'SUBSIDY_COMMITTED');
    const first = await commitVerifiedVoucherFunding(manager, payment.id);
    expect(first.status).toBe('SETTLED');
    expect(entries.filter(entry => entry.kind === 'SUBSIDY_COMMITTED')).toEqual([
      expect.objectContaining({ linkId: link.id, invoiceId: invoice.id, amountVnd: 50,
        evidenceSha256: link.allocationSha256 }),
    ]);
    await commitVerifiedVoucherFunding(manager, payment.id);
    expect(entries.filter(entry => entry.kind === 'SUBSIDY_COMMITTED')).toHaveLength(1);
    entries = entries.filter(entry => entry.kind !== 'SUBSIDY_COMMITTED');
    payment.status = PaymentAttemptStatus.FAILED;
    await expect(commitVerifiedVoucherFunding(manager, payment.id)).rejects.toThrow();
    expect(entries.some(entry => entry.kind === 'SUBSIDY_COMMITTED')).toBe(false);
  });

  it('refuses journal commitment for an expired or released reservation', async () => {
    entries = entries.filter(entry => entry.kind !== 'SUBSIDY_COMMITTED');
    for (const state of ['EXPIRED', 'RELEASED']) {
      reservation.state = state;
      await expect(commitVerifiedVoucherFunding(manager, payment.id)).rejects.toThrow();
      expect(entries.some(entry => entry.kind === 'SUBSIDY_COMMITTED')).toBe(false);
    }
    reservation.state = 'REDEEMED';
    reservation.settlementId = 'foreign-payment';
    await expect(commitVerifiedVoucherFunding(manager, payment.id)).rejects.toThrow();
  });

  it('rejects extra, duplicate, or wrong-value company funding rows', async () => {
    entries.push({ linkId: link.id, kind: 'SUBSIDY_COMMITTED',
      invoiceId: 'foreign-invoice', amountVnd: 50, evidenceSha256: link.allocationSha256 });
    await expect(loadVoucherSettlementFacts(manager, payment.id)).rejects.toThrow();
    entries.pop();
    entries.push({ ...entries[2] });
    await expect(loadVoucherSettlementFacts(manager, payment.id)).rejects.toThrow();
    entries.pop();
    entries[2].amountVnd = 0;
    await expect(loadVoucherSettlementFacts(manager, payment.id)).rejects.toThrow();
  });

  it('fails closed for missing provider proof, quarantine, missing company journal or stale invoice', async () => {
    for (const kind of ['PROVIDER_PAID', 'SUBSIDY_COMMITTED']) {
      const removed = entries.splice(entries.findIndex(entry => entry.kind === kind), 1)[0];
      await expect(loadVoucherSettlementFacts(manager, 'payment-1')).rejects.toThrow();
      entries.push(removed);
    }
    entries.push({ linkId: link.id, kind: 'QUARANTINED', invoiceId: null });
    await expect(loadVoucherSettlementFacts(manager, 'payment-1')).rejects.toThrow();
    entries.pop();
    invoice.grandTotal = 101;
    await expect(loadVoucherSettlementFacts(manager, 'payment-1')).rejects.toThrow();
  });

  it('refuses wrong owner, amount, source id, paid time or original commission', async () => {
    payment.amount = 100;
    await expect(loadVoucherSettlementFacts(manager, 'payment-1')).rejects.toThrow();
    payment.amount = 50;
    payment.requestedByUserId = 'foreign';
    await expect(loadVoucherSettlementFacts(manager, 'payment-1')).rejects.toThrow();
    payment.requestedByUserId = 'customer-1';
    link.paymentId = 'other';
    await expect(loadVoucherSettlementFacts(manager, 'payment-1')).rejects.toThrow();
    link.paymentId = 'payment-1';
    entries[1].providerPaidAt = new Date('2026-10-26T15:15:00Z');
    await expect(loadVoucherSettlementFacts(manager, 'payment-1')).rejects.toThrow();
    entries[1].providerPaidAt = new Date('2026-10-26T15:14:59Z');
    invoice.commissionAmount = 9;
    await expect(loadVoucherSettlementFacts(manager, 'payment-1')).rejects.toThrow();
  });

  it('refuses a paid solo invoice owned by another booking customer', async () => {
    booking.customerId = 'foreign';
    await expect(loadVoucherSettlementFacts(manager, payment.id)).rejects.toThrow();
  });

  it('verifies every VisitGroup child amount and original snapshot before settlement', async () => {
    const second = { ...link.allocationSnapshot[0], invoiceId: 'invoice-2' };
    link.allocationSnapshot.push(second);
    link.allocationSha256 = voucherAllocationDigest(link.allocationSnapshot);
    link.scopeKind = 'VISIT_GROUP'; link.scopeId = 'group-1';
    link.paymentId = null; link.visitGroupPaymentId = 'group-payment-1';
    link.originalGrossVnd = 200; link.eligibleBaseVnd = 200;
    link.subsidyVnd = 100; link.customerDueVnd = 100;
    reservation.scopeId = 'group-1'; reservation.checkoutSnapshot.eligibleSubtotalVnd = 200;
    entries[0].evidenceSha256 = link.allocationSha256;
    entries[2].evidenceSha256 = link.allocationSha256;
    entries.push({ linkId: link.id, kind: 'SUBSIDY_COMMITTED', invoiceId: 'invoice-2',
      amountVnd: 50, evidenceSha256: link.allocationSha256 });
    const secondInvoice = { ...invoice, id: 'invoice-2', serviceOrderId: 'order-2' };
    const secondPayment = { ...payment, id: 'child-payment-2', invoiceId: 'invoice-2',
      providerReference: 'VN-123:invoice-2' };
    const groupPayment = { id: 'group-payment-1', visitGroupId: 'group-1',
      rail: 'vnpay', status: 'verified', amount: 100, requestedByUserId: 'customer-1',
      requestedAt: payment.requestedAt, verifiedAt: payment.verifiedAt,
      idempotencyKey: link.providerTxnRef, providerReference: 'VN-123',
      allocations: [
        { invoiceId: 'invoice-1', serviceOrderId: 'order-1', amount: 50 },
        { invoiceId: 'invoice-2', serviceOrderId: 'order-2', amount: 50 },
      ] };
    let childCustomer = 'customer-1';
    vi.mocked(manager.findOne).mockImplementation(async (entity: unknown, options: any) =>
      entity === VoucherPaymentLink ? link : entity === VoucherReservation ? reservation :
        entity === VoucherCampaign ? { id: 'campaign-1' } as never :
        entity === VisitGroup ? { id: 'group-1', customerId: 'customer-1' } as never :
          entity === VisitGroupPayment ? groupPayment :
            entity === Invoice ? options.where.id === 'invoice-2' ? secondInvoice : invoice :
              entity === ServiceOrder ? { id: options.where.id,
                bookingId: options.where.id === 'order-2' ? 'booking-2' : booking.id } :
                entity === Booking ? { id: options.where.id,
                  customerId: options.where.id === 'booking-2' ? childCustomer : 'customer-1',
                  visitGroupId: 'group-1' } :
              entity === Payment ? options.where.invoiceId === 'invoice-2' ? secondPayment :
                { ...payment, providerReference: 'VN-123:invoice-1' } : null);
    expect((await loadVoucherSettlementFacts(manager, 'group-payment-1')).status).toBe('SETTLED');
    groupPayment.allocations[1].amount = 100;
    await expect(loadVoucherSettlementFacts(manager, 'group-payment-1')).rejects.toThrow();
    groupPayment.allocations[1].amount = 50;
    childCustomer = 'foreign';
    await expect(loadVoucherSettlementFacts(manager, 'group-payment-1')).rejects.toThrow();
  });

  it('requires confirmed solo cash and a linked technician credit before settlement', async () => {
    link.rail = 'CASH'; link.paymentId = null; link.cashSettlementId = 'cash-1';
    link.providerTxnRef = null; link.providerInitiatedAt = null;
    invoice.paidAt = new Date('2026-10-26T15:03:00Z');
    entries = entries.filter(entry => !entry.kind.startsWith('PROVIDER_'));
    entries.push({ linkId: link.id, kind: 'CASH_TECH_CREDIT', invoiceId: invoice.id,
      amountVnd: 50, walletTransactionId: 'wallet-tx-1', evidenceSha256: link.allocationSha256 });
    const cash = { id: 'cash-1', serviceOrderId: 'order-1',
      status: CashSettlementStatus.CONFIRMED, confirmedByCustomerId: 'customer-1',
      declaredByTechnicianId: 'tech-1', declaredAmount: 50, confirmedAmount: 50,
      declaredAt: new Date('2026-10-26T15:01:00Z'), confirmedAt: invoice.paidAt };
    const wallet = { id: 'wallet-1', technicianId: 'tech-1' };
    const walletTransaction = { id: 'wallet-tx-1', walletId: wallet.id,
      type: WalletTransactionType.ADJUSTMENT, amount: 50,
      balanceBefore: 10, balanceAfter: 60, referenceType: 'VOUCHER_FUNDING',
      referenceId: link.id, idempotencyKey: `VOUCHER_CASH_CREDIT:${link.id}:${invoice.id}` };
    vi.mocked(manager.findOne).mockImplementation(async (entity: unknown) =>
      entity === VoucherPaymentLink ? link : entity === VoucherReservation ? reservation :
        entity === VoucherCampaign ? { id: 'campaign-1' } :
        entity === CashSettlement ? cash : entity === Invoice ? invoice :
          entity === WalletTransaction ? walletTransaction : entity === Wallet ? wallet :
            entity === ServiceOrder ? { id: 'order-1', bookingId: booking.id } :
              entity === Booking ? booking : null);
    expect((await loadVoucherSettlementFacts(manager, 'cash-1')).status).toBe('SETTLED');
    walletTransaction.balanceBefore = -100;
    walletTransaction.balanceAfter = -50;
    expect((await loadVoucherSettlementFacts(manager, 'cash-1')).status).toBe('SETTLED');
    walletTransaction.balanceAfter = -49;
    await expect(loadVoucherSettlementFacts(manager, 'cash-1')).rejects.toThrow();
    walletTransaction.balanceAfter = -50;
    walletTransaction.amount = 49;
    await expect(loadVoucherSettlementFacts(manager, 'cash-1')).rejects.toThrow();
    walletTransaction.amount = 50;
    wallet.technicianId = 'foreign-tech';
    await expect(loadVoucherSettlementFacts(manager, 'cash-1')).rejects.toThrow();
    wallet.technicianId = 'tech-1';
    cash.confirmedByCustomerId = 'foreign';
    await expect(loadVoucherSettlementFacts(manager, 'cash-1')).rejects.toThrow();
    cash.confirmedByCustomerId = 'customer-1';
    entries.pop();
    await expect(loadVoucherSettlementFacts(manager, 'cash-1')).rejects.toThrow();
  });

  it('accepts backend 0 VND settlement only with paid invoice and full company journal', async () => {
    link.rail = 'ZERO'; link.paymentId = null; link.providerTxnRef = null;
    link.providerInitiatedAt = null; link.customerDueVnd = 0; link.subsidyVnd = 100;
    link.allocationSnapshot[0].customerDueVnd = 0;
    link.allocationSnapshot[0].subsidyVnd = 100;
    link.allocationSha256 = voucherAllocationDigest(link.allocationSnapshot);
    link.createdAt = new Date('2026-10-26T15:01:00Z');
    invoice.paidAt = new Date('2026-10-26T15:02:00Z');
    entries = [{ linkId: link.id, kind: 'SUBSIDY_COMMITTED', invoiceId: invoice.id,
      amountVnd: 100, evidenceSha256: link.allocationSha256 }];
    expect((await loadVoucherSettlementFacts(manager, link.id)).settledAt).toEqual(invoice.paidAt);
    invoice.paymentStatus = PaymentStatus.UNPAID;
    await expect(loadVoucherSettlementFacts(manager, link.id)).rejects.toThrow();
  });
});
