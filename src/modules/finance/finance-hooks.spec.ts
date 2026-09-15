import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../../common/exceptions/business.exception';
import {
  CommissionDueStatus,
  PaymentStatus,
  PlatformDueStatus,
} from '../../shared/enums';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { PlatformDue } from './entities/platform-due.entity';
import { FinanceService } from './finance.service';

const makeHooksService = (options: {
  commissionDues?: CommissionDue[];
  assignments?: { serviceOrderId: string }[];
  pendingPlatformDue?: PlatformDue | null;
  order?: ServiceOrder | null;
  invoice?: Invoice | null;
}) => {
  const commissionDueRepository = {
    find: vi.fn().mockResolvedValue(options.commissionDues ?? []),
  };
  const assignmentRepository = {
    findOne: vi.fn(),
    find: vi.fn().mockResolvedValue(options.assignments ?? []),
  };
  const platformDueRepository = {
    findOne: vi.fn().mockResolvedValue(options.pendingPlatformDue ?? null),
    findAndCount: vi.fn(),
  };
  const serviceOrderRepository = {
    findOne: vi.fn().mockResolvedValue(options.order ?? null),
    findOneBy: vi.fn(),
    update: vi.fn(),
  };
  const invoiceRepository = {
    findOne: vi.fn().mockResolvedValue(options.invoice ?? null),
    findOneBy: vi.fn(),
    save: vi.fn(),
  };

  const service = new FinanceService(
    invoiceRepository as any,
    serviceOrderRepository as any,
    {} as any,
    assignmentRepository as any,
    {} as any,
    commissionDueRepository as any,
    {} as any,
    platformDueRepository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  return {
    service,
    commissionDueRepository,
    assignmentRepository,
    platformDueRepository,
    serviceOrderRepository,
    invoiceRepository,
  };
};

const due = (overrides: Partial<CommissionDue> = {}): CommissionDue =>
  ({
    id: 'due-1',
    serviceOrderId: 'order-1',
    technicianId: 'technician-1',
    status: CommissionDueStatus.PENDING,
    ...overrides,
  }) as CommissionDue;

describe('FinanceService Dev1 integration hooks', () => {
  it('exposes read-only hook contracts without mutating state', () => {
    const hooks = makeHooksService({});
    expect(typeof hooks.service.hasActiveUnpaidPlatformDue).toBe('function');
    expect(typeof hooks.service.isOrderPaymentSatisfied).toBe('function');
  });

  it('reports legacy pending commission debt even without a platform due row', async () => {
    const hooks = makeHooksService({
      commissionDues: [due({ status: CommissionDueStatus.PENDING })],
      pendingPlatformDue: null,
    });

    await expect(
      hooks.service.hasActiveUnpaidPlatformDue('technician-1'),
    ).resolves.toBe(true);
    expect(hooks.platformDueRepository.findOne).not.toHaveBeenCalled();
  });

  it('reports canonical pending platform dues when legacy debt is clear', async () => {
    const hooks = makeHooksService({
      commissionDues: [
        due({ serviceOrderId: 'order-1', status: CommissionDueStatus.PAID }),
      ],
      assignments: [{ serviceOrderId: 'order-1' }],
      pendingPlatformDue: { id: 'platform-due-1' } as PlatformDue,
    });

    await expect(
      hooks.service.hasActiveUnpaidPlatformDue('technician-1'),
    ).resolves.toBe(true);
    expect(hooks.platformDueRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: PlatformDueStatus.PENDING }),
      }),
    );
  });

  it('reports eligible when legacy dues are settled and no platform due is pending', async () => {
    const hooks = makeHooksService({
      commissionDues: [
        due({ serviceOrderId: 'order-1', status: CommissionDueStatus.PAID }),
      ],
      assignments: [{ serviceOrderId: 'order-1' }],
      pendingPlatformDue: null,
    });

    await expect(
      hooks.service.hasActiveUnpaidPlatformDue('technician-1'),
    ).resolves.toBe(false);
  });

  it('reports eligible when the technician has no dues or assignments', async () => {
    const hooks = makeHooksService({});

    await expect(
      hooks.service.hasActiveUnpaidPlatformDue('technician-1'),
    ).resolves.toBe(false);
    expect(hooks.platformDueRepository.findOne).not.toHaveBeenCalled();
  });

  it('rejects blank hook input instead of silently reporting eligible', async () => {
    const hooks = makeHooksService({});
    await expect(hooks.service.hasActiveUnpaidPlatformDue('')).rejects.toBeInstanceOf(
      BusinessException,
    );
    await expect(hooks.service.isOrderPaymentSatisfied('')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('treats PAID invoices as satisfied and nothing else', async () => {
    const order = { id: 'order-1' } as ServiceOrder;
    const paid = makeHooksService({
      order,
      invoice: { paymentStatus: PaymentStatus.PAID } as Invoice,
    });
    await expect(paid.service.isOrderPaymentSatisfied('order-1')).resolves.toBe(
      true,
    );

    const unpaid = makeHooksService({
      order,
      invoice: { paymentStatus: PaymentStatus.UNPAID } as Invoice,
    });
    await expect(unpaid.service.isOrderPaymentSatisfied('order-1')).resolves.toBe(
      false,
    );

    const refunded = makeHooksService({
      order,
      invoice: { paymentStatus: PaymentStatus.REFUNDED } as Invoice,
    });
    await expect(
      refunded.service.isOrderPaymentSatisfied('order-1'),
    ).resolves.toBe(false);
    expect(refunded.serviceOrderRepository.update).not.toHaveBeenCalled();
  });

  it('treats cash mismatch/dispute as unsatisfied and missing records as unsatisfied', async () => {
    const order = { id: 'order-1' } as ServiceOrder;
    const disputedCash = makeHooksService({
      order,
      invoice: { paymentStatus: PaymentStatus.UNPAID } as Invoice,
    });
    await expect(
      disputedCash.service.isOrderPaymentSatisfied('order-1'),
    ).resolves.toBe(false);

    const missingInvoice = makeHooksService({ order, invoice: null });
    await expect(
      missingInvoice.service.isOrderPaymentSatisfied('order-1'),
    ).resolves.toBe(false);

    const missingOrder = makeHooksService({ order: null, invoice: null });
    await expect(
      missingOrder.service.isOrderPaymentSatisfied('order-1'),
    ).resolves.toBe(false);
  });
});
