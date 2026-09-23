import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../../common/exceptions/business.exception';
import {
  CommissionDueStatus,
  PaymentStatus,
} from '../../shared/enums';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { PlatformDue } from './entities/platform-due.entity';
import { FinanceService } from './finance.service';

const makeHooksService = (options: {
  legacyPending?: boolean;
  activeAssignment?: boolean;
  pendingPlatformDue?: PlatformDue | null;
  order?: ServiceOrder | null;
  invoice?: Invoice | null;
}) => {
  const commissionDueRepository = {
    exists: vi.fn().mockResolvedValue(options.legacyPending ?? false),
  };
  // Emulates the bounded inner-join semantics: the canonical pending due is
  // reachable only through an ACTIVE assignment for this technician.
  const qb = {
    innerJoin: vi.fn(),
    where: vi.fn(),
    select: vi.fn(),
    limit: vi.fn(),
    getOne: vi.fn().mockResolvedValue(
      options.activeAssignment && options.pendingPlatformDue
        ? options.pendingPlatformDue
        : null,
    ),
  };
  qb.innerJoin.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  qb.select.mockReturnValue(qb);
  qb.limit.mockReturnValue(qb);
  const platformDueRepository = {
    createQueryBuilder: vi.fn().mockReturnValue(qb),
    findOne: vi.fn(),
    findAndCount: vi.fn(),
  };
  const assignmentRepository = {
    findOne: vi.fn(),
    find: vi.fn().mockResolvedValue([]),
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
    {} as any,
    {} as any,
  );

  return {
    service,
    commissionDueRepository,
    assignmentRepository,
    platformDueRepository,
    qb,
    serviceOrderRepository,
    invoiceRepository,
  };
};

describe('FinanceService Dev1 integration hooks', () => {
  it('exposes read-only hook contracts without mutating state', () => {
    const hooks = makeHooksService({});
    expect(typeof hooks.service.hasActiveUnpaidPlatformDue).toBe('function');
    expect(typeof hooks.service.isOrderPaymentSatisfied).toBe('function');
  });

  it('reports legacy pending commission debt even without a platform due row', async () => {
    const hooks = makeHooksService({ legacyPending: true });

    await expect(
      hooks.service.hasActiveUnpaidPlatformDue('technician-1'),
    ).resolves.toBe(true);
    expect(hooks.commissionDueRepository.exists).toHaveBeenCalledWith({
      where: {
        technicianId: 'technician-1',
        status: CommissionDueStatus.PENDING,
      },
    });
    // Short-circuits before touching the canonical platform-due query.
    expect(hooks.platformDueRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('reports canonical pending platform dues only through an ACTIVE assignment', async () => {
    const hooks = makeHooksService({
      legacyPending: false,
      activeAssignment: true,
      pendingPlatformDue: { id: 'platform-due-1' } as PlatformDue,
    });

    await expect(
      hooks.service.hasActiveUnpaidPlatformDue('technician-1'),
    ).resolves.toBe(true);
    expect(hooks.platformDueRepository.createQueryBuilder).toHaveBeenCalledWith(
      'due',
    );
    const joinCondition = hooks.qb.innerJoin.mock.calls[0][2] as string;
    const joinParams = hooks.qb.innerJoin.mock.calls[0][3] as Record<
      string,
      unknown
    >;
    expect(joinCondition).toContain('isActive');
    expect(joinParams).toMatchObject({
      technicianId: 'technician-1',
      isActive: true,
    });
  });

  it('ignores canonical pending dues after reassignment (historic inactive assignment)', async () => {
    const hooks = makeHooksService({
      legacyPending: false,
      activeAssignment: false,
      pendingPlatformDue: { id: 'platform-due-1' } as PlatformDue,
    });

    await expect(
      hooks.service.hasActiveUnpaidPlatformDue('technician-1'),
    ).resolves.toBe(false);
    // No unbounded history load: the hook never pulls assignment/order arrays.
    expect(hooks.assignmentRepository.find).not.toHaveBeenCalled();
  });

  it('reports eligible when legacy dues are settled and no platform due is pending', async () => {
    const hooks = makeHooksService({
      legacyPending: false,
      activeAssignment: true,
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
    expect(hooks.qb.getOne).toHaveBeenCalled();
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
