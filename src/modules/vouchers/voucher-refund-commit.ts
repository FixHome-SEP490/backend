import { voucherAllocationDigest } from './voucher-allocation-digest';
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { PaymentStatus, Role, SupportCaseStatus, WalletTransactionType } from '../../shared/enums';
import { CustomerWallet } from '../customer-wallet/entities/customer-wallet.entity';
import { CustomerWalletTransaction } from '../customer-wallet/entities/customer-wallet-transaction.entity';
import type { CustomerWalletService } from '../customer-wallet/customer-wallet.service';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { REFUND_CASE_TYPES } from '../support-cases/support-case-policy';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { User } from '../users/entities/user.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import type { WalletService } from '../wallet/wallet.service';
import { VoucherFundingEntry, VoucherPaymentLink } from './entities/voucher-funding.entity';
import { VoucherCampaign, VoucherClaim, VoucherReservation } from './entities/voucher.entity';
import { calculateVoucherRefundDelta } from './voucher-funding-allocation';
import { lockVoucherFundingReservation } from './voucher-funding-lock';
import { creditVoucherCustomerRefund } from './voucher-refund-wallet';
import { loadVoucherSettlementFacts } from './voucher-settlement-evidence';
import { ReservationState } from './voucher.types';

function inconsistent(): never {
  throw new ConflictException('Nguồn hoàn tiền ưu đãi chưa được xác minh đầy đủ.');
}

function vnd(value: unknown): number {
  const parsed = Number(value);
  if (value === null || value === undefined || value === '' ||
      !Number.isSafeInteger(parsed) || parsed < 0) inconsistent();
  return parsed;
}

export interface VoucherRefundCommitResult {
  readonly refundSourceId: string;
  readonly invoiceId: string;
  readonly customerRefundVnd: number;
  readonly subsidyReversalVnd: number;
  readonly quotaRestored: boolean;
  readonly replayed: boolean;
}

/**
 * F3 internal seam, intentionally not registered on a route. The SupportCase
 * amount remains the manager-approved customer NET refund. If the immutable
 * allocation cannot uniquely identify the corresponding gross amount, this
 * seam refuses to reverse funding until a verified gross source is available.
 * The customer-wallet credit and journal share the caller's DB transaction.
 */
export async function commitVerifiedVoucherSupportRefund(
  manager: EntityManager,
  refundSourceId: string,
  customerWalletService?: CustomerWalletService,
  walletService?: WalletService,
): Promise<VoucherRefundCommitResult> {
  if (!manager.queryRunner?.isTransactionActive) inconsistent();
  // Identity discovery is lock-free. Funded paths lock campaign then reservation
  // before locking the source/invoice, matching Apply and expiry sweep order.
  const sourceReference = await manager.findOne(SupportCase, { where: { id: refundSourceId } });
  if (!sourceReference?.serviceOrderId) inconsistent();
  const invoiceReference = await manager.findOne(Invoice, {
    where: { serviceOrderId: sourceReference.serviceOrderId },
  });
  if (!invoiceReference) inconsistent();
  const matched: { id: string }[] = await manager.query(`
    SELECT id FROM public.voucher_payment_links
    WHERE allocation_snapshot @> $1::jsonb LIMIT 2
  `, [JSON.stringify([{ invoiceId: invoiceReference.id }])]);
  if (!Array.isArray(matched) || matched.length !== 1) inconsistent();
  const referenceLink = await manager.findOne(VoucherPaymentLink, { where: { id: matched[0].id } });
  if (!referenceLink) inconsistent();
  const reservation = await lockVoucherFundingReservation(manager, referenceLink.reservationId);
  const source = await manager.findOne(SupportCase, {
    where: { id: refundSourceId }, lock: { mode: 'pessimistic_read' },
  });
  if (!source || source.id !== refundSourceId ||
      source.serviceOrderId !== sourceReference.serviceOrderId ||
      source.status !== SupportCaseStatus.RESOLVED ||
      !(REFUND_CASE_TYPES as readonly string[]).includes(source.caseType) ||
      source.resolutionCode !== 'refund_to_wallet' ||
      !source.customerId || !source.assignedManagerId ||
      vnd(source.amount) < 0 || vnd(source.voucherGrossRefundVnd) <= 0) inconsistent();
  const approvingManager = await manager.findOne(User, {
    where: { id: source.assignedManagerId }, lock: { mode: 'pessimistic_read' },
  });
  if (!approvingManager || approvingManager.role !== Role.SERVICE_MANAGER) inconsistent();
  const invoice = await manager.findOne(Invoice, {
    where: { id: invoiceReference.id }, lock: { mode: 'pessimistic_read' },
  });
  if (!invoice || invoice.serviceOrderId !== source.serviceOrderId ||
      invoice.paymentStatus !== PaymentStatus.PAID) inconsistent();
  const link = await manager.findOne(VoucherPaymentLink, {
    where: { id: referenceLink.id }, lock: { mode: 'pessimistic_read' },
  });
  if (!link || link.id !== referenceLink.id || link.reservationId !== reservation.id ||
      link.customerId !== source.customerId || link.scopeId !== reservation.scopeId ||
      !Array.isArray(link.allocationSnapshot) ||
      voucherAllocationDigest(link.allocationSnapshot) !== link.allocationSha256) inconsistent();
  // Approved F3: refund only to the FixHome customer wallet regardless of the
  // original payment method. Do NOT reverse VNPay or pay out cash. Require
  // validated original settlement evidence (signed VNPay payment or customer-
  // confirmed cash) via loadVoucherSettlementFacts before any wallet credit.
  if (!(['WALLET', 'VNPAY', 'CASH', 'ZERO'] as string[]).includes(link.rail)) inconsistent();
  const allocation = link.allocationSnapshot.find(row => row.invoiceId === invoice.id);
  if (!allocation || link.allocationSnapshot.filter(row => row.invoiceId === invoice.id).length !== 1 ||
      vnd(invoice.grandTotal) !== vnd(allocation.originalGrossVnd) ||
      vnd(invoice.commissionAmount) !== vnd(allocation.commissionAmountVnd) ||
      Number(invoice.commissionRateSnapshot) !== allocation.commissionRateSnapshot ||
      vnd(invoice.commissionAmount) + vnd(invoice.fixHomePartsTotal) +
        vnd(invoice.shippingFee) !== vnd(allocation.originalPlatformDueVnd)) inconsistent();
  const entries = await manager.find(VoucherFundingEntry, { where: { linkId: link.id } });
  const sameSource = entries.filter(entry => entry.refundSourceId === refundSourceId);
  const key = (kind: string) => `REFUND:${refundSourceId}:${invoice.id}:${kind}`;
  const earlier = entries.filter(entry => entry.invoiceId === invoice.id &&
    entry.refundSourceId !== refundSourceId);
  const priorCustomer = earlier.filter(entry => entry.kind === 'CUSTOMER_REFUND')
    .reduce((sum, entry) => sum + vnd(entry.amountVnd), 0);
  const priorSubsidy = earlier.filter(entry => entry.kind === 'SUBSIDY_REVERSAL')
    .reduce((sum, entry) => sum + vnd(entry.amountVnd), 0);
  const priorGross = priorCustomer + priorSubsidy;
  if (!Number.isSafeInteger(priorGross) || priorGross > allocation.originalGrossVnd) inconsistent();
  let priorTarget: ReturnType<typeof calculateVoucherRefundDelta>;
  let delta: ReturnType<typeof calculateVoucherRefundDelta>;
  try {
    priorTarget = calculateVoucherRefundDelta(allocation, 0, priorGross);
    delta = calculateVoucherRefundDelta(allocation, priorGross, priorGross + vnd(source.voucherGrossRefundVnd));
  } catch { inconsistent(); }
  if (delta.customerRefundVnd !== vnd(source.amount) ||
      priorTarget.customerRefundVnd !== priorCustomer ||
      priorTarget.subsidyReversalVnd !== priorSubsidy) inconsistent();

  const customerKey = key('CUSTOMER_REFUND');
  let walletTransaction = await manager.findOne(CustomerWalletTransaction, {
    where: { idempotencyKey: customerKey }, lock: { mode: 'pessimistic_read' },
  });
  if (sameSource.length > 0 && delta.customerRefundVnd > 0) {
    const customerWallet = walletTransaction && await manager.findOne(CustomerWallet, {
      where: { id: walletTransaction.walletId }, lock: { mode: 'pessimistic_read' },
    });
    if (!walletTransaction || !customerWallet || customerWallet.userId !== link.customerId ||
        walletTransaction.type !== 'refund' ||
        vnd(walletTransaction.amount) !== delta.customerRefundVnd ||
        vnd(walletTransaction.balanceAfter) - vnd(walletTransaction.balanceBefore) !== delta.customerRefundVnd ||
        walletTransaction.referenceType !== 'SERVICE_ORDER' ||
        walletTransaction.referenceId !== source.serviceOrderId) inconsistent();
  } else if (sameSource.length > 0 && walletTransaction) inconsistent();

  if (sameSource.length > 0) {
    const customer = sameSource.filter(entry => entry.kind === 'CUSTOMER_REFUND' &&
      entry.invoiceId === invoice.id && entry.idempotencyKey === customerKey);
    const reversal = sameSource.filter(entry => entry.kind === 'SUBSIDY_REVERSAL' &&
      entry.invoiceId === invoice.id && entry.idempotencyKey === key('SUBSIDY_REVERSAL'));
    const quota = sameSource.filter(entry => entry.kind === 'QUOTA_RESTORED' &&
      entry.idempotencyKey === key('QUOTA_RESTORED'));
    if (sameSource.length !== customer.length + reversal.length + quota.length ||
        customer.length !== Number(delta.customerRefundVnd > 0) ||
        reversal.length !== Number(delta.subsidyReversalVnd > 0) || quota.length > 1 ||
        (customer.length === 1 && (vnd(customer[0].amountVnd) !== delta.customerRefundVnd ||
          customer[0].customerWalletTransactionId !== walletTransaction?.id)) ||
        (reversal.length === 1 && vnd(reversal[0].amountVnd) !== delta.subsidyReversalVnd)) inconsistent();
    return { refundSourceId, invoiceId: invoice.id, customerRefundVnd: delta.customerRefundVnd,
      subsidyReversalVnd: delta.subsidyReversalVnd,
      quotaRestored: quota.length === 1, replayed: true };
  }
  if (reservation.state !== ReservationState.REDEEMED ||
      !reservation.settlementId || !source.resolvedAt) inconsistent();
  await loadVoucherSettlementFacts(manager, reservation.settlementId);
  if (walletTransaction) inconsistent();
  if (delta.customerRefundVnd > 0) {
    if (!customerWalletService) inconsistent();
    walletTransaction = await creditVoucherCustomerRefund(manager, customerWalletService, {
      customerId: link.customerId, serviceOrderId: source.serviceOrderId,
      refundSourceId, invoiceId: invoice.id, netVnd: delta.customerRefundVnd,
    });
    await manager.save(VoucherFundingEntry, manager.create(VoucherFundingEntry, {
      linkId: link.id, invoiceId: invoice.id, kind: 'CUSTOMER_REFUND',
      amountVnd: delta.customerRefundVnd, idempotencyKey: customerKey,
      providerReference: null, providerPaidAt: null, evidenceSha256: link.allocationSha256,
      walletTransactionId: null, customerWalletTransactionId: walletTransaction!.id,
      refundSourceId,
    }));
  }
  let technicianDebitId: string | null = null;
  if (delta.subsidyReversalVnd > 0 && link.rail === 'CASH') {
    const credit = entries.find(entry => entry.kind === 'CASH_TECH_CREDIT' &&
      entry.invoiceId === invoice.id && entry.walletTransactionId);
    const original = credit && await manager.findOne(WalletTransaction, {
      where: { id: credit.walletTransactionId! }, lock: { mode: 'pessimistic_read' },
    });
    const wallet = original && await manager.findOne(Wallet, {
      where: { id: original.walletId }, lock: { mode: 'pessimistic_read' },
    });
    if (!credit || !original || !wallet || !walletService ||
        original.type !== WalletTransactionType.ADJUSTMENT ||
        vnd(original.amount) !== vnd(credit.amountVnd)) inconsistent();
    const debitKey = key('SUBSIDY_REVERSAL');
    const { transaction } = await walletService.mutateBalance({
      walletId: wallet.id, type: WalletTransactionType.ADJUSTMENT,
      amount: delta.subsidyReversalVnd, debit: true,
      referenceType: 'VOUCHER_REFUND', referenceId: refundSourceId,
      idempotencyKey: debitKey, manager,
    });
    if (!transaction || transaction.walletId !== wallet.id ||
        transaction.type !== WalletTransactionType.ADJUSTMENT ||
        vnd(transaction.amount) !== delta.subsidyReversalVnd ||
        vnd(transaction.balanceBefore) - vnd(transaction.balanceAfter) !== delta.subsidyReversalVnd ||
        transaction.referenceType !== 'VOUCHER_REFUND' ||
        transaction.referenceId !== refundSourceId || transaction.idempotencyKey !== debitKey) inconsistent();
    technicianDebitId = transaction.id;
  }
  if (delta.subsidyReversalVnd > 0) {
    await manager.save(VoucherFundingEntry, manager.create(VoucherFundingEntry, {
      linkId: link.id, invoiceId: invoice.id, kind: 'SUBSIDY_REVERSAL',
      amountVnd: delta.subsidyReversalVnd, idempotencyKey: key('SUBSIDY_REVERSAL'),
      providerReference: null, providerPaidAt: null, evidenceSha256: link.allocationSha256,
      walletTransactionId: technicianDebitId, customerWalletTransactionId: null,
      refundSourceId,
    }));
  }
  const current = await manager.find(VoucherFundingEntry, { where: { linkId: link.id } });
  const fullyRefunded = link.allocationSnapshot.every(row => {
    const rows = current.filter(entry => entry.invoiceId === row.invoiceId);
    return rows.filter(entry => entry.kind === 'CUSTOMER_REFUND')
      .reduce((sum, entry) => sum + vnd(entry.amountVnd), 0) === row.customerDueVnd &&
      rows.filter(entry => entry.kind === 'SUBSIDY_REVERSAL')
        .reduce((sum, entry) => sum + vnd(entry.amountVnd), 0) === row.subsidyVnd;
  });
  if (fullyRefunded) {
    const claim = await manager.findOne(VoucherClaim, {
      where: { id: reservation.claimId, customerId: reservation.customerId },
      lock: { mode: 'pessimistic_write' },
    });
    const campaign = await manager.findOne(VoucherCampaign, {
      where: { id: reservation.campaignId }, lock: { mode: 'pessimistic_write' },
    });
    if (!claim || !claim.redeemedAt || !campaign || campaign.redeemed < 1 ||
        current.some(entry => entry.kind === 'QUOTA_RESTORED')) inconsistent();
    await manager.save(VoucherFundingEntry, manager.create(VoucherFundingEntry, {
      linkId: link.id, invoiceId: null, kind: 'QUOTA_RESTORED', amountVnd: 0,
      idempotencyKey: key('QUOTA_RESTORED'),
      providerReference: null, providerPaidAt: null, evidenceSha256: link.allocationSha256,
      walletTransactionId: null, customerWalletTransactionId: null, refundSourceId,
    }));
    reservation.state = ReservationState.REFUNDED;
    claim.redeemedAt = null;
    campaign.redeemed -= 1;
    await manager.save(VoucherReservation, reservation);
    await manager.save(VoucherClaim, claim);
    await manager.save(VoucherCampaign, campaign);
  }
  return { refundSourceId, invoiceId: invoice.id,
    customerRefundVnd: delta.customerRefundVnd,
    subsidyReversalVnd: delta.subsidyReversalVnd,
    quotaRestored: fullyRefunded, replayed: false };
}
