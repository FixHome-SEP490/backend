import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { PaymentAttemptStatus } from '../../shared/enums';
import { Payment } from '../finance/entities/payment.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { VoucherFundingEntry, VoucherPaymentLink } from './entities/voucher-funding.entity';
import { VoucherCampaign, VoucherReservation } from './entities/voucher.entity';
import { canReleaseVoucherReservation, recordSignedVoucherVnpayOutcome } from './voucher-provider-ledger';

const secret = 'isolated-test-secret';
const reservedAt = new Date('2026-10-26T15:00:00Z');
const expiresAt = new Date('2026-10-26T15:15:00Z');
const now = new Date('2026-10-26T15:30:00Z');

function signed(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const values = {
    vnp_TxnRef: 'provider-attempt-1', vnp_Amount: '5000', vnp_TmnCode: 'TMNCODE01',
    vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: 'VN-123',
    vnp_PayDate: '20261026221459', ...overrides,
  };
  const fields = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Record<string, string>;
  const sorted = Object.keys(fields).sort().map(key =>
    `${key}=${encodeURIComponent(fields[key]).replace(/%20/g, '+')}`).join('&');
  return { ...fields, vnp_SecureHash: createHmac('sha512', secret).update(Buffer.from(sorted, 'utf-8')).digest('hex') };
}

describe('durable funded VNPay callback evidence', () => {
  let manager: EntityManager;
  let entries: any[];
  let reservation: any;
  let link: any;
  let payment: any;
  let groupPayment: any;

  beforeEach(() => {
    reservation = { id: 'reservation-1', campaignId: 'campaign-1',
      state: 'RESERVED', attemptId: 'voucher-attempt-1',
      customerId: 'customer-1', scopeId: 'scope-1', reservedAt, expiresAt };
    link = { id: 'link-1', reservationId: reservation.id, attemptId: reservation.attemptId,
      customerId: reservation.customerId, scopeId: reservation.scopeId, rail: 'VNPAY',
      providerTxnRef: 'provider-attempt-1', providerInitiatedAt: new Date('2026-10-26T15:01:00Z'),
      customerDueVnd: 50, allocationSha256: 'a'.repeat(64) };
    entries = [{ id: 'pending-1', linkId: link.id, kind: 'PROVIDER_PENDING',
      evidenceSha256: link.allocationSha256, amountVnd: 0 }];
    payment = { id: 'payment-1', status: PaymentAttemptStatus.PENDING,
      amount: 50, provider: 'vnpay', requestedByUserId: reservation.customerId,
      idempotencyKey: link.providerTxnRef };
    groupPayment = null;
    link.paymentId = payment.id;
    link.visitGroupPaymentId = null;
    manager = {
      queryRunner: { isTransactionActive: true },
      findOne: vi.fn(async (entity: unknown, options: any) => entity === VoucherReservation ? reservation :
        entity === VoucherCampaign ? { id: 'campaign-1' } :
        entity === VoucherPaymentLink ? link : entity === VoucherFundingEntry ?
          entries.find(entry => Object.entries(options.where).every(([key, value]) => entry[key] === value)) ?? null :
          entity === Payment ? payment : entity === VisitGroupPayment ? groupPayment : null),
      find: vi.fn(async (entity: unknown) => entity === VoucherFundingEntry ? entries : []),
      create: vi.fn((_entity: unknown, value: unknown) => value),
      save: vi.fn(async (_entity: unknown, value: any) => {
        const saved = { id: `entry-${entries.length}`, ...value }; entries.push(saved); return saved;
      }),
      query: vi.fn(async () => [{ now }]),
    } as unknown as EntityManager;
  });

  it('refuses signed evidence persistence without an active database transaction', async () => {
    (manager.queryRunner as { isTransactionActive: boolean }).isTransactionActive = false;
    await expect(recordSignedVoucherVnpayOutcome(manager, reservation.id, signed(), 'TMNCODE01', secret))
      .rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('persists signed pay time before expiry even when callback arrives late and replays once', async () => {
    const first = await recordSignedVoucherVnpayOutcome(manager, reservation.id, signed(), 'TMNCODE01', secret);
    const calls = vi.mocked(manager.findOne).mock.calls;
    const campaignLock = calls.findIndex(([entity, options]: any[]) => entity === VoucherCampaign &&
      options.lock?.mode === 'pessimistic_write');
    const reservationLock = calls.findIndex(([entity, options]: any[]) => entity === VoucherReservation &&
      options.lock?.mode === 'pessimistic_write');
    expect(campaignLock).toBeGreaterThanOrEqual(0);
    expect(campaignLock).toBeLessThan(reservationLock);
    expect(first).toMatchObject({ decision: 'SETTLE', providerPaidAt: new Date('2026-10-26T15:14:59Z') });
    expect(entries.filter(entry => entry.kind === 'PROVIDER_PAID')).toHaveLength(1);
    expect(entries.at(-1)).toMatchObject({ kind: 'PROVIDER_PAID', amountVnd: 0,
      providerReference: 'VN-123', providerPaidAt: new Date('2026-10-26T15:14:59Z') });
    expect(await recordSignedVoucherVnpayOutcome(manager, reservation.id, signed(), 'TMNCODE01', secret))
      .toMatchObject({ decision: 'SETTLE' });
    expect(entries.filter(entry => entry.kind === 'PROVIDER_PAID')).toHaveLength(1);
  });

  it('keeps an unfinished signed report pending and accepts its later terminal paid proof', async () => {
    expect((await recordSignedVoucherVnpayOutcome(manager, reservation.id, signed({
      vnp_ResponseCode: '99', vnp_TransactionStatus: '01', vnp_PayDate: undefined,
    }), 'TMNCODE01', secret)).decision).toBe('KEEP_PENDING');
    expect(entries).toHaveLength(1);
    expect((await recordSignedVoucherVnpayOutcome(manager, reservation.id,
      signed(), 'TMNCODE01', secret)).decision).toBe('SETTLE');
    expect(entries.filter(entry => entry.kind === 'PROVIDER_PAID')).toHaveLength(1);
  });

  it('quarantines missing pay time, post-expiry payment, and conflicting terminal callbacks', async () => {
    expect((await recordSignedVoucherVnpayOutcome(manager, reservation.id,
      signed({ vnp_PayDate: undefined }), 'TMNCODE01', secret)).decision).toBe('QUARANTINE');
    expect(entries.some(entry => entry.kind === 'PROVIDER_PAID')).toBe(false);
    expect((await recordSignedVoucherVnpayOutcome(manager, reservation.id,
      signed({ vnp_PayDate: '20261026221500' }), 'TMNCODE01', secret)).decision).toBe('QUARANTINE');
    expect((await recordSignedVoucherVnpayOutcome(manager, reservation.id,
      signed(), 'TMNCODE01', secret)).decision).toBe('QUARANTINE');
    expect(entries.some(entry => entry.kind === 'PROVIDER_PAID')).toBe(false);
  });

  it('keeps signed post-expiry paid time and provider reference for refund reconciliation', async () => {
    const result = await recordSignedVoucherVnpayOutcome(manager, reservation.id,
      signed({ vnp_PayDate: '20261026221500' }), 'TMNCODE01', secret);
    expect(result).toMatchObject({ decision: 'QUARANTINE', providerReference: 'VN-123',
      providerPaidAt: new Date('2026-10-26T15:15:00Z') });
    expect(entries.at(-1)).toMatchObject({ kind: 'QUARANTINED', providerReference: 'VN-123',
      providerPaidAt: new Date('2026-10-26T15:15:00Z') });
    expect(entries.some(entry => entry.kind === 'PROVIDER_PAID')).toBe(false);
  });

  it('records signed no-funds failure once, but never treats a later paid report as safe', async () => {
    const failed = signed({ vnp_ResponseCode: '24', vnp_TransactionStatus: '02', vnp_PayDate: undefined });
    expect((await recordSignedVoucherVnpayOutcome(manager, reservation.id, failed, 'TMNCODE01', secret)).decision)
      .toBe('RELEASE');
    expect(entries.filter(entry => entry.kind === 'PROVIDER_FAILED')).toHaveLength(1);
    expect((await recordSignedVoucherVnpayOutcome(manager, reservation.id, failed, 'TMNCODE01', secret)).decision)
      .toBe('RELEASE');
    expect(entries.filter(entry => entry.kind === 'PROVIDER_FAILED')).toHaveLength(1);
    expect((await recordSignedVoucherVnpayOutcome(manager, reservation.id, signed(), 'TMNCODE01', secret)).decision)
      .toBe('QUARANTINE');
  });

  it('rejects unauthenticated or mismatched callbacks without writing evidence', async () => {
    const tampered = signed(); tampered.vnp_Amount = '1';
    expect((await recordSignedVoucherVnpayOutcome(manager, reservation.id, tampered, 'TMNCODE01', secret)).decision)
      .toBe('QUARANTINE');
    expect(manager.save).not.toHaveBeenCalled();
    expect((await recordSignedVoucherVnpayOutcome(manager, reservation.id,
      signed({ vnp_TxnRef: 'foreign' }), 'TMNCODE01', secret)).decision).toBe('QUARANTINE');
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('keeps provider pending capacity, then releases only after signed failure and failed source', async () => {
    expect(await canReleaseVoucherReservation(manager, reservation.id)).toBe(false);
    const failed = signed({ vnp_ResponseCode: '24', vnp_TransactionStatus: '02', vnp_PayDate: undefined });
    await recordSignedVoucherVnpayOutcome(manager, reservation.id, failed, 'TMNCODE01', secret);
    expect(await canReleaseVoucherReservation(manager, reservation.id)).toBe(false);
    payment.status = PaymentAttemptStatus.FAILED;
    expect(await canReleaseVoucherReservation(manager, reservation.id)).toBe(true);
    entries.push({ linkId: link.id, kind: 'QUARANTINED' });
    expect(await canReleaseVoucherReservation(manager, reservation.id)).toBe(false);
  });

  it('uses the same signed failure gate for a failed VisitGroup provider source', async () => {
    link.paymentId = null;
    link.visitGroupPaymentId = 'group-payment-1';
    groupPayment = { id: 'group-payment-1', status: 'failed', rail: 'vnpay',
      amount: 50, visitGroupId: reservation.scopeId,
      requestedByUserId: reservation.customerId, idempotencyKey: link.providerTxnRef };
    const failed = signed({ vnp_ResponseCode: '24', vnp_TransactionStatus: '02', vnp_PayDate: undefined });
    await recordSignedVoucherVnpayOutcome(manager, reservation.id, failed, 'TMNCODE01', secret);
    expect(await canReleaseVoucherReservation(manager, reservation.id)).toBe(true);
    groupPayment.amount = 500;
    expect(await canReleaseVoucherReservation(manager, reservation.id)).toBe(false);
  });
});
