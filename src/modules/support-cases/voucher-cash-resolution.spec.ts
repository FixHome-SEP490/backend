import { describe, expect, it, vi } from 'vitest';
import { SupportCasesService } from './support-cases.service';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { VoucherPaymentLink } from '../vouchers/entities/voucher-funding.entity';
import { CASH_SETTLEMENT_MANAGER_CONFIRMATION_CODE } from '../../shared/constants';
import { SupportCaseStatus, SupportCaseType } from '../../shared/enums';

describe('funded cash dispute resolution boundary', () => {
  it('rejects legacy gross settlement before a manager can mutate funded cash', async () => {
    const cash = { id: 'cash-1', serviceOrderId: 'order-1', status: 'disputed' };
    const invoice = { id: 'invoice-1', grandTotal: 100000, paymentStatus: 'unpaid' };
    const save = vi.fn(async (value: unknown) => value);
    const finance = { applyConfirmedCash: vi.fn() };
    const manager = {
      findOne: vi.fn(async (entity: unknown) => entity === VoucherPaymentLink
        ? { cashSettlementId: cash.id, rail: 'CASH' } : null),
      getRepository: (entity: unknown) => ({ save, findOne: async () =>
        entity === CashSettlement ? cash : entity === Invoice ? invoice :
          entity === ServiceOrder ? { id: 'order-1' } : null }),
    };
    const service = Object.assign(Object.create(SupportCasesService.prototype), {
      moduleRef: { get: () => finance },
    });
    await expect(service.applyCashSettlementResolution(manager, {
      serviceOrderId: 'order-1', caseType: SupportCaseType.CASH_MISMATCH,
    }, SupportCaseStatus.RESOLVED, CASH_SETTLEMENT_MANAGER_CONFIRMATION_CODE,
    { id: 'manager-1', role: 'service_manager' }, 'Verified dispute'))
      .rejects.toMatchObject({ status: 409 });
    expect(cash.status).toBe('disputed');
    expect(save).not.toHaveBeenCalled();
    expect(finance.applyConfirmedCash).not.toHaveBeenCalled();
  });
});
