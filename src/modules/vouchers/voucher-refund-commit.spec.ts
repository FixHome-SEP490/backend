import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { User } from '../users/entities/user.entity';
import { VoucherPaymentLink } from './entities/voucher-funding.entity';
import { VoucherCampaign, VoucherReservation } from './entities/voucher.entity';
import { commitVerifiedVoucherSupportRefund } from './voucher-refund-commit';

describe('funded support refund boundary', () => {
  it('rejects a refund outside an active database transaction', async () => {
    const manager = { queryRunner: { isTransactionActive: false }, findOne: vi.fn() } as unknown as EntityManager;
    await expect(commitVerifiedVoucherSupportRefund(manager, 'case-id')).rejects.toThrow();
    expect(manager.findOne).not.toHaveBeenCalled();
  });

  it('rejects missing persisted refund source before any ledger write', async () => {
    const manager = {
      queryRunner: { isTransactionActive: true },
      findOne: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
    } as unknown as EntityManager;
    await expect(commitVerifiedVoucherSupportRefund(manager, 'case-id')).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('refuses recorded original-rail refunds before any wallet credit', async () => {
    const source = {
      id: 'case-1', serviceOrderId: 'order-1', customerId: 'customer-1',
      status: 'resolved', caseType: 'parts_dispute',
      resolutionCode: 'refund_recorded', assignedManagerId: 'manager-1', amount: 30,
    };
    const findOne = vi.fn(async (entity: unknown) => entity === SupportCase ? source :
      entity === Invoice ? { id: 'invoice-1', serviceOrderId: 'order-1' } :
      entity === VoucherPaymentLink ? { id: 'link-1', reservationId: 'reservation-1' } :
      entity === VoucherReservation ? { id: 'reservation-1', campaignId: 'campaign-1' } :
      entity === VoucherCampaign ? { id: 'campaign-1' } : null);
    const manager = {
      queryRunner: { isTransactionActive: true }, findOne,
      query: vi.fn().mockResolvedValue([{ id: 'link-1' }]), save: vi.fn(),
    } as unknown as EntityManager;
    const customerWalletService = { apply: vi.fn() };
    await expect(commitVerifiedVoucherSupportRefund(
      manager, 'case-1', customerWalletService as never,
    )).rejects.toThrow();
    expect(findOne).not.toHaveBeenCalledWith(User, expect.anything());
    expect(customerWalletService.apply).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });
});
