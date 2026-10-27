import { voucherAllocationDigest } from './voucher-allocation-digest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { CashSettlementStatus, PaymentStatus, WalletTransactionType } from '../../shared/enums';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { WalletService } from '../wallet/wallet.service';
import { Wallet } from '../wallet/entities/wallet.entity';
import { VoucherFundingEntry, VoucherPaymentLink } from './entities/voucher-funding.entity';
import { VoucherCampaign, VoucherReservation } from './entities/voucher.entity';
import { commitConfirmedCashVoucherFunding } from './voucher-cash-credit';

describe('confirmed cash company subsidy', () => {
  let manager: EntityManager;
  let wallet: Pick<WalletService, 'getOrCreateWallet' | 'mutateBalance'>;
  let cash: any;
  let invoice: any;
  let entries: any[];
  let link: any;
  let groupPayment: any;
  let invoices: any[];
  let cashes: any[];
  beforeEach(() => {
    const allocation = { invoiceId: 'invoice-1', originalGrossVnd: 100,
      eligibleBaseVnd: 100, subsidyVnd: 80, customerDueVnd: 20,
      originalPlatformDueVnd: 10, technicianEntitlementVnd: 90,
      commissionRateSnapshot: 0.1, commissionAmountVnd: 10 };
    link = { id: 'link-1', reservationId: 'reservation-1', attemptId: 'attempt-1', rail: 'CASH',
      customerId: 'customer-1', scopeId: 'order-1', scopeKind: 'SOLO',
      cashSettlementId: 'cash-1', visitGroupPaymentId: null,
      originalGrossVnd: 100, subsidyVnd: 80, customerDueVnd: 20,
      allocationSnapshot: [allocation],
      allocationSha256: voucherAllocationDigest([allocation]) };
    cash = { id: 'cash-1', serviceOrderId: 'order-1',
      status: CashSettlementStatus.CONFIRMED, confirmedByCustomerId: 'customer-1',
      declaredByTechnicianId: 'tech-1', declaredAmount: 20, confirmedAmount: 20,
      confirmedAt: new Date('2026-10-26T15:02:00Z') };
    invoice = { id: 'invoice-1', serviceOrderId: 'order-1',
      grandTotal: 100, commissionAmount: 10, commissionRateSnapshot: 0.1,
      fixHomePartsTotal: 0, shippingFee: 0,
      paidAt: cash.confirmedAt, paymentStatus: PaymentStatus.PAID };
    invoices = [invoice];
    cashes = [cash];
    groupPayment = null;
    entries = [];
    manager = {
      queryRunner: { isTransactionActive: true },
      findOne: vi.fn(async (entity: unknown, options: any) => entity === VoucherReservation ?
        { id: 'reservation-1', campaignId: 'campaign-1',
          attemptId: 'attempt-1', customerId: 'customer-1',
          scopeId: 'order-1', state: 'RESERVED',
          reservedAt: new Date('2026-10-26T15:00:00Z'),
          expiresAt: new Date('2026-10-26T15:15:00Z') } :
        entity === VoucherCampaign ? { id: 'campaign-1' } :
        entity === VoucherPaymentLink ? link : entity === CashSettlement ?
          cashes.find(row => Object.entries(options.where).every(([key, value]) => row[key] === value)) ?? null :
          entity === Invoice ? invoices.find(row => row.id === options.where.id) ?? null :
          entity === VisitGroupPayment ? groupPayment : entity === VoucherFundingEntry ?
            entries.find(entry => Object.entries(options.where).every(([key, value]) => entry[key] === value)) ?? null : null),
      create: vi.fn((_entity: unknown, value: unknown) => value),
      save: vi.fn(async (_entity: unknown, value: any) => {
        const saved = { id: `entry-${entries.length}`, ...value }; entries.push(saved); return saved;
      }),
    } as unknown as EntityManager;
    wallet = {
      getOrCreateWallet: vi.fn(async () => ({ id: 'wallet-1', technicianId: 'tech-1' }) as never),
      mutateBalance: vi.fn(async (params: any) => ({ transaction: {
        id: params.idempotencyKey.endsWith('invoice-1') ? 'wallet-tx-1' : 'wallet-tx-2',
        walletId: 'wallet-1', type: WalletTransactionType.ADJUSTMENT,
        amount: params.amount, referenceType: 'VOUCHER_FUNDING', referenceId: link.id,
        idempotencyKey: params.idempotencyKey,
      } }) as never),
    };
  });

  it('refuses company wallet credit outside an active database transaction', async () => {
    (manager.queryRunner as { isTransactionActive: boolean }).isTransactionActive = false;
    await expect(commitConfirmedCashVoucherFunding(manager, link.reservationId, wallet as WalletService))
      .rejects.toThrow();
    expect(wallet.mutateBalance).not.toHaveBeenCalled();
  });

  it('credits a technician still in debt using the real wallet mutation', async () => {
    const technicianWallet = { id: 'wallet-1', technicianId: 'tech-1', balance: -100 };
    const original = vi.mocked(wallet.mutateBalance);
    const realWallet = Object.assign(Object.create(WalletService.prototype), {
      getMinimumBalance: async () => 0,
    }) as WalletService;
    manager.getRepository = ((entity: unknown) => entity === Wallet ? {
      findOne: async () => technicianWallet,
      save: async (value: unknown) => value,
    } : {
      findOne: async () => null,
      create: (value: unknown) => value,
      save: async (value: object) => ({ ...value, id: 'wallet-tx-1' }),
    }) as unknown as EntityManager['getRepository'];
    original.mockImplementation(params => realWallet.mutateBalance(params));
    expect(await commitConfirmedCashVoucherFunding(manager, link.reservationId, wallet as WalletService)).toBe(80);
    expect(technicianWallet.balance).toBe(-20);
    expect(entries.find(entry => entry.kind === 'CASH_TECH_CREDIT').walletTransactionId).toBe('wallet-tx-1');
  });

  it('credits the full subsidy once after confirmation, even above original PlatformDue', async () => {
    await commitConfirmedCashVoucherFunding(manager, link.reservationId, wallet as WalletService);
    expect(wallet.mutateBalance).toHaveBeenCalledWith(expect.objectContaining({
      amount: 80, type: WalletTransactionType.ADJUSTMENT, debit: false,
      manager, referenceType: 'VOUCHER_FUNDING', referenceId: link.id,
    }));
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'SUBSIDY_COMMITTED', invoiceId: invoice.id, amountVnd: 80 }),
      expect.objectContaining({ kind: 'CASH_TECH_CREDIT', invoiceId: invoice.id,
        amountVnd: 80, walletTransactionId: 'wallet-tx-1' }),
    ]));
    await commitConfirmedCashVoucherFunding(manager, link.reservationId, wallet as WalletService);
    expect(wallet.mutateBalance).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(2);
  });

  it('refuses unconfirmed, wrong-customer, stale amount or unpaid source without credit', async () => {
    for (const change of [
      () => { cash.status = CashSettlementStatus.PENDING_CONFIRMATION; },
      () => { cash.status = CashSettlementStatus.CONFIRMED; cash.confirmedByCustomerId = 'foreign'; },
      () => { cash.confirmedByCustomerId = 'customer-1'; cash.confirmedAmount = 100; },
      () => { cash.confirmedAmount = 20; invoice.paymentStatus = PaymentStatus.UNPAID; },
    ]) {
      change();
      await expect(commitConfirmedCashVoucherFunding(manager, link.reservationId, wallet as WalletService))
        .rejects.toThrow();
    }
    expect(wallet.mutateBalance).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
  });

  it('refuses a changed original commission or invoice paid timestamp before company credit', async () => {
    invoice.commissionAmount = 11;
    await expect(commitConfirmedCashVoucherFunding(manager, link.reservationId, wallet as WalletService))
      .rejects.toThrow();
    invoice.commissionAmount = 10;
    invoice.paidAt = new Date('2026-10-26T15:03:00Z');
    await expect(commitConfirmedCashVoucherFunding(manager, link.reservationId, wallet as WalletService))
      .rejects.toThrow();
    expect(wallet.mutateBalance).not.toHaveBeenCalled();
  });

  it('credits VisitGroup cash per successful invoice only after matching all child confirmations', async () => {
    const second = { ...link.allocationSnapshot[0], invoiceId: 'invoice-2',
      originalGrossVnd: 50, eligibleBaseVnd: 50, subsidyVnd: 40, customerDueVnd: 10,
      technicianEntitlementVnd: 40 };
    link.scopeKind = 'VISIT_GROUP';
    link.scopeId = 'group-1';
    link.cashSettlementId = null;
    link.visitGroupPaymentId = 'group-payment-1';
    link.allocationSnapshot.push(second);
    link.originalGrossVnd = 150;
    link.subsidyVnd = 120;
    link.customerDueVnd = 30;
    link.allocationSha256 = voucherAllocationDigest(link.allocationSnapshot);
    groupPayment = { id: 'group-payment-1', visitGroupId: 'group-1', rail: 'cash',
      status: 'verified', amount: 30, requestedByUserId: 'tech-1',
      allocations: [
        { invoiceId: 'invoice-1', serviceOrderId: 'order-1', amount: 20 },
        { invoiceId: 'invoice-2', serviceOrderId: 'order-2', amount: 10 },
      ] };
    invoices.push({ id: 'invoice-2', serviceOrderId: 'order-2',
      grandTotal: 50, commissionAmount: 10, commissionRateSnapshot: 0.1,
      fixHomePartsTotal: 0, shippingFee: 0,
      paidAt: new Date('2026-10-26T15:02:00Z'), paymentStatus: PaymentStatus.PAID });
    cashes.push({ id: 'cash-2', serviceOrderId: 'order-2',
      status: CashSettlementStatus.CONFIRMED, confirmedByCustomerId: 'customer-1',
      declaredByTechnicianId: 'tech-1', declaredAmount: 10, confirmedAmount: 10,
      confirmedAt: new Date('2026-10-26T15:02:00Z') });
    vi.mocked(manager.findOne).mockImplementation(async (entity: unknown, options: any) =>
      entity === VoucherReservation ? { id: 'reservation-1', campaignId: 'campaign-1',
        attemptId: 'attempt-1',
        customerId: 'customer-1', scopeId: 'group-1', state: 'RESERVED',
        reservedAt: new Date('2026-10-26T15:00:00Z'),
        expiresAt: new Date('2026-10-26T15:15:00Z') } as never :
        entity === VoucherCampaign ? { id: 'campaign-1' } as never :
        entity === VoucherPaymentLink ? link : entity === VisitGroupPayment ? groupPayment :
          entity === CashSettlement ? cashes.find(row => row.serviceOrderId === options.where.serviceOrderId) ?? null :
            entity === Invoice ? invoices.find(row => row.id === options.where.id) ?? null :
              entity === VoucherFundingEntry ? entries.find(row => Object.entries(options.where)
                .every(([key, value]) => row[key] === value)) ?? null : null);
    expect(await commitConfirmedCashVoucherFunding(manager, link.reservationId, wallet as WalletService)).toBe(120);
    expect(vi.mocked(wallet.mutateBalance).mock.calls.map(([params]) => params.amount)).toEqual([80, 40]);
    expect(entries.filter(entry => entry.kind === 'CASH_TECH_CREDIT')).toHaveLength(2);
    groupPayment.allocations[1].amount = 50;
    await expect(commitConfirmedCashVoucherFunding(manager, link.reservationId, wallet as WalletService))
      .rejects.toThrow();
  });
});
