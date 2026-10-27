import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { PaymentStatus, Role, SupportCaseStatus, WalletTransactionType } from '../../shared/enums';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { User } from '../users/entities/user.entity';
import { CustomerWalletTransaction } from '../customer-wallet/entities/customer-wallet-transaction.entity';
import { VoucherPaymentLink, VoucherFundingEntry } from './entities/voucher-funding.entity';
import { VoucherClaim, VoucherCampaign } from './entities/voucher.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { voucherAllocationDigest } from './voucher-allocation-digest';
import { commitVerifiedVoucherSupportRefund } from './voucher-refund-commit';
import { ReservationState } from './voucher.types';

const mocks = vi.hoisted(() => ({ lock: vi.fn(), proof: vi.fn(), credit: vi.fn() }));
vi.mock('./voucher-funding-lock', () => ({ lockVoucherFundingReservation: mocks.lock }));
vi.mock('./voucher-settlement-evidence', () => ({ loadVoucherSettlementFacts: mocks.proof }));
vi.mock('./voucher-refund-wallet', () => ({ creditVoucherCustomerRefund: mocks.credit }));

describe('F3 wallet-only owner policy regardless of payment rail', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it.each(['VNPAY', 'CASH', 'WALLET', 'ZERO'])('requires VERIFIED original settlement proof before refunding %s to the customer wallet', async rail => {
    const allocation = {
      invoiceId: 'invoice-1', originalGrossVnd: 500000,
      commissionAmountVnd: 25000, commissionRateSnapshot: 5,
      originalPlatformDueVnd: 25000, technicianEntitlementVnd: 475000,
      eligibleBaseVnd: 500000, subsidyVnd: 100000, customerDueVnd: 400000,
    };
    const source = {
      id: 'case-1', serviceOrderId: 'order-1', customerId: 'customer-1',
      assignedManagerId: 'manager-1', status: SupportCaseStatus.RESOLVED,
      resolutionCode: 'refund_to_wallet', caseType: 'parts_dispute',
      amount: 400000, voucherGrossRefundVnd: 500000, resolvedAt: new Date(),
    };
    const invoice = { id: 'invoice-1', serviceOrderId: 'order-1',
      paymentStatus: PaymentStatus.PAID, grandTotal: 500000,
      commissionAmount: 25000, commissionRateSnapshot: 5,
      fixHomePartsTotal: 0, shippingFee: 0 };
    const link = { id: 'link-1', reservationId: 'reservation-1',
      customerId: 'customer-1', scopeId: 'order-1', scopeKind: 'SOLO', rail,
      allocationSnapshot: [allocation], allocationSha256: voucherAllocationDigest([allocation]) };
    mocks.lock.mockResolvedValue({ id: 'reservation-1', scopeId: 'order-1',
      state: ReservationState.REDEEMED, settlementId: 'payment-1' });
    const findOne = vi.fn(async (entity: unknown) => entity === SupportCase ? source
      : entity === Invoice ? invoice
      : entity === VoucherPaymentLink ? link
      : entity === User ? { id: 'manager-1', role: Role.SERVICE_MANAGER }
      : entity === CustomerWalletTransaction ? null : null);
    const save = vi.fn();
    const manager = {
      queryRunner: { isTransactionActive: true }, findOne,
      find: vi.fn(async (entity: unknown) => entity === VoucherFundingEntry ? [] : []),
      query: vi.fn().mockResolvedValue([{ id: 'link-1' }]), save,
    } as unknown as EntityManager;
    mocks.proof.mockRejectedValueOnce(new Error('Original settlement not verified'));
    const customerWalletService = { apply: vi.fn() };
    await expect(commitVerifiedVoucherSupportRefund(manager, 'case-1', customerWalletService as never))
      .rejects.toThrow('Original settlement not verified');
    expect(mocks.proof).toHaveBeenCalledWith(manager, 'payment-1');
    expect(customerWalletService.apply).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['VNPAY', 'CASH'])('credits the verified %s customer net to FixHome wallet, reverses subsidy and restores quota only once', async rail => {
    const allocation = {
      invoiceId: 'invoice-1', originalGrossVnd: 500000, eligibleBaseVnd: 500000,
      subsidyVnd: 100000, customerDueVnd: 400000, commissionAmountVnd: 25000,
      commissionRateSnapshot: 5, originalPlatformDueVnd: 25000,
      technicianEntitlementVnd: 475000,
    };
    const source = {
      id: 'case-1', serviceOrderId: 'order-1', customerId: 'customer-1',
      assignedManagerId: 'manager-1', status: SupportCaseStatus.RESOLVED,
      resolutionCode: 'refund_to_wallet', caseType: 'parts_dispute',
      amount: 400000, voucherGrossRefundVnd: 500000, resolvedAt: new Date(),
    };
    const invoice = { id: 'invoice-1', serviceOrderId: 'order-1',
      paymentStatus: PaymentStatus.PAID, grandTotal: 500000,
      commissionAmount: 25000, commissionRateSnapshot: 5,
      fixHomePartsTotal: 0, shippingFee: 0 };
    const link = { id: 'link-1', reservationId: 'reservation-1',
      customerId: 'customer-1', scopeId: 'order-1', scopeKind: 'SOLO', rail,
      allocationSnapshot: [allocation], allocationSha256: voucherAllocationDigest([allocation]) };
    const reservation = { id: 'reservation-1', scopeId: 'order-1', campaignId: 'campaign-1',
      claimId: 'claim-1', customerId: 'customer-1', state: ReservationState.REDEEMED, settlementId: 'payment-1' };
    const claim = { id: 'claim-1', customerId: 'customer-1', redeemedAt: new Date() };
    const campaign = { id: 'campaign-1', redeemed: 1 };
    mocks.lock.mockResolvedValue(reservation);
    mocks.proof.mockResolvedValue({ status: 'SETTLED', settlementId: 'payment-1' });
    mocks.credit.mockResolvedValue({ id: 'wallet-refund-1' });
    const entries: Array<Record<string, unknown>> = [
      { kind: 'SUBSIDY_COMMITTED', invoiceId: 'invoice-1', linkId: 'link-1',
        amountVnd: 100000, refundSourceId: null },
    ];
    if (rail === 'CASH') entries.push({ kind: 'CASH_TECH_CREDIT',
      invoiceId: 'invoice-1', linkId: 'link-1', walletTransactionId: 'tech-credit-1',
      amountVnd: 100000, refundSourceId: null });
    const findOne = vi.fn(async (entity: unknown) => entity === SupportCase ? source
      : entity === Invoice ? invoice
      : entity === VoucherPaymentLink ? link
      : entity === User ? { id: 'manager-1', role: Role.SERVICE_MANAGER }
      : entity === CustomerWalletTransaction ? null
      : entity === WalletTransaction ? { id: 'tech-credit-1', walletId: 'tech-wallet-1',
        type: WalletTransactionType.ADJUSTMENT, amount: 100000 }
      : entity === Wallet ? { id: 'tech-wallet-1', technicianId: 'tech-1' }
      : entity === VoucherClaim ? claim : entity === VoucherCampaign ? campaign : null);
    const manager = {
      queryRunner: { isTransactionActive: true }, findOne,
      query: vi.fn().mockResolvedValue([{ id: 'link-1' }]),
      find: vi.fn(async (entity: unknown) => entity === VoucherFundingEntry ? [...entries] : []),
      create: vi.fn((_entity: unknown, obj: unknown) => obj),
      save: vi.fn(async (entity: unknown, obj: Record<string, unknown>) => {
        if (entity === VoucherFundingEntry) entries.push(obj);
        return obj;
      }),
    } as unknown as EntityManager;
    const walletService = {
      mutateBalance: vi.fn(async (params: { idempotencyKey: string }) => ({
        transaction: { id: 'tech-debit-1', walletId: 'tech-wallet-1', type: WalletTransactionType.ADJUSTMENT,
          amount: 100000, balanceBefore: 120000, balanceAfter: 20000,
          referenceType: 'VOUCHER_REFUND', referenceId: 'case-1', idempotencyKey: params.idempotencyKey },
      })),
    };
    const result = await commitVerifiedVoucherSupportRefund(
      manager, 'case-1', {} as never, walletService as never,
    );
    expect(result).toMatchObject({ customerRefundVnd: 400000,
      subsidyReversalVnd: 100000, quotaRestored: true, replayed: false });
    expect(mocks.proof).toHaveBeenCalledOnce();
    expect(mocks.credit).toHaveBeenCalledOnce();
    expect(mocks.credit).toHaveBeenCalledWith(manager, expect.anything(),
      expect.objectContaining({ customerId: 'customer-1', netVnd: 400000 }));
    expect(entries.filter(entry => entry.kind === 'CUSTOMER_REFUND')).toHaveLength(1);
    expect(entries.filter(entry => entry.kind === 'SUBSIDY_REVERSAL')).toHaveLength(1);
    expect(entries.filter(entry => entry.kind === 'QUOTA_RESTORED')).toHaveLength(1);
    expect(walletService.mutateBalance).toHaveBeenCalledTimes(rail === 'CASH' ? 1 : 0);
    expect(reservation.state).toBe(ReservationState.REFUNDED);
  });
});
