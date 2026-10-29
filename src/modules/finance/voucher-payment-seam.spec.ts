import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { FinanceService } from './finance.service';
import { bindVoucherPaymentLink } from '../vouchers/voucher-payment-link';

vi.mock('../vouchers/voucher-payment-link', () => ({ bindVoucherPaymentLink: vi.fn() }));

const customerId = 'customer-1';
const scopeId = 'scope-1';
const reservationId = 'reservation-1';

describe('Finance voucher payment link seam', () => {
  const service = Object.create(FinanceService.prototype) as FinanceService;
  const manager = { queryRunner: { isTransactionActive: true } } as unknown as EntityManager;

  it.each([
    ['SOLO', 'WALLET', 'paymentId'],
    ['SOLO', 'VNPAY', 'paymentId'],
    ['SOLO', 'CASH', 'cashSettlementId'],
    ['VISIT_GROUP', 'WALLET', 'visitGroupPaymentId'],
    ['VISIT_GROUP', 'VNPAY', 'visitGroupPaymentId'],
    ['VISIT_GROUP', 'CASH', 'visitGroupPaymentId'],
  ] as const)('binds %s %s only to the record in the active payment transaction', async (scopeKind, rail, sourceField) => {
    vi.mocked(bindVoucherPaymentLink).mockResolvedValueOnce({
      id: 'link-1', reservationId, customerId, scopeId, scopeKind, rail,
      paymentId: null, cashSettlementId: null, visitGroupPaymentId: null,
      [sourceField]: 'source-1',
    } as never);
    const link = await service.bindVoucherPaymentAfterRecord(manager, {
      reservationId, rail, sourceId: 'source-1', customerId, scopeId, scopeKind,
    });
    expect(link.id).toBe('link-1');
    expect(bindVoucherPaymentLink).toHaveBeenCalledWith(manager, reservationId, rail, 'source-1');
  });

  it('rejects calls outside a transaction before binding', async () => {
    vi.mocked(bindVoucherPaymentLink).mockClear();
    await expect(service.bindVoucherPaymentAfterRecord({} as EntityManager, {
      reservationId, rail: 'WALLET', sourceId: 'source-1', customerId, scopeId, scopeKind: 'SOLO',
    })).rejects.toThrow();
    expect(bindVoucherPaymentLink).not.toHaveBeenCalled();
  });

  it.each(['customerId', 'scopeId', 'scopeKind', 'paymentId'] as const)(
    'rejects a mismatched %s after binding so the caller transaction rolls back', async (field) => {
      vi.mocked(bindVoucherPaymentLink).mockResolvedValueOnce({
        id: 'link-1', reservationId, customerId, scopeId, scopeKind: 'SOLO', rail: 'WALLET',
        paymentId: 'source-1', cashSettlementId: null, visitGroupPaymentId: null,
        [field]: 'other',
      } as never);
      await expect(service.bindVoucherPaymentAfterRecord(manager, {
        reservationId, rail: 'WALLET', sourceId: 'source-1', customerId, scopeId, scopeKind: 'SOLO',
      })).rejects.toThrow();
    },
  );

  it('rejects a binding returned for another reservation', async () => {
    vi.mocked(bindVoucherPaymentLink).mockResolvedValueOnce({
      id: 'link-1', reservationId: 'other', customerId, scopeId, scopeKind: 'SOLO', rail: 'WALLET',
      paymentId: 'source-1',
    } as never);
    await expect(service.bindVoucherPaymentAfterRecord(manager, {
      reservationId, rail: 'WALLET', sourceId: 'source-1', customerId, scopeId, scopeKind: 'SOLO',
    })).rejects.toThrow();
  });

  it('does not treat a zero-due closeout as a payment-record rail', async () => {
    vi.mocked(bindVoucherPaymentLink).mockClear();
    await expect(service.bindVoucherPaymentAfterRecord(manager, {
      reservationId, rail: 'ZERO' as never, sourceId: 'source-1', customerId, scopeId, scopeKind: 'SOLO',
    })).rejects.toThrow();
    expect(bindVoucherPaymentLink).not.toHaveBeenCalled();
  });
});
