import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceService } from './finance.service';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { OrderStatusHistory } from '../service-orders/entities/order-status-history.entity';
import { PaymentStatus, PartRequestStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { applyOrderCompletionEffects } from '../service-orders/order-completion-effects';
import { isCompletionHeld } from '../support-cases/completion-hold';

vi.mock('../service-orders/order-completion-effects', () => ({ applyOrderCompletionEffects: vi.fn() }));
vi.mock('../support-cases/completion-hold', () => ({ isCompletionHeld: vi.fn() }));

function fixture(hasHolder = true, requested = true) {
  const events: string[] = [];
  const invoice = {
    id: 'invoice-1', serviceOrderId: 'order-1', grandTotal: 150_000,
    paymentStatus: PaymentStatus.UNPAID, paidAt: null as Date | null,
  };
  const order = {
    id: 'order-1', bookingId: 'booking-1', status: ServiceOrderStatus.UNDER_REPAIR,
    paymentStatus: PaymentStatus.UNPAID, completionRequestedAt: requested ? new Date() : null,
    completedAt: null as Date | null,
  };
  const repository = {
    save: vi.fn(async <T>(item: T) => item),
    update: vi.fn(async () => ({ affected: 1 })),
  };
  const manager = {
    getRepository: vi.fn((entity: unknown) => {
      expect([Invoice, ServiceOrder]).toContain(entity);
      return repository;
    }),
    findOne: vi.fn(async (entity: unknown) => entity === ServiceOrder ? order : null),
    findOneBy: vi.fn(async (entity: unknown, where: { serviceOrderId?: string; isActive?: boolean }) => {
      if (entity === TechnicianAssignment && where.serviceOrderId === order.id && where.isActive)
        return hasHolder ? { technicianId: 'technician-new', isActive: true } : null;
      return null;
    }),
    update: vi.fn(async (entity: unknown, _where?: unknown, _patch?: unknown) => {
      if (entity === PartRequest) events.push('part-request-closed');
      return { affected: 1 };
    }),
    insert: vi.fn(async (entity: unknown) => {
      if (entity === OrderStatusHistory) events.push('order-completed');
      return { identifiers: [] };
    }),
  };
  const dues = vi.fn(async () => undefined);
  const cashPayment = vi.fn(async () => undefined);
  const finance = Object.assign(Object.create(FinanceService.prototype), {
    ensureFinancialDues: dues,
    ensureCashPayment: cashPayment,
    settlementService: null,
  }) as FinanceService;
  vi.mocked(isCompletionHeld).mockResolvedValue(false);
  vi.mocked(applyOrderCompletionEffects).mockImplementation(async () => { events.push('completion-effects'); });
  return { manager, invoice, order, finance, events, cashPayment, dues };
}

describe('BUG #26 paid-completion closes only the current technician logical parts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('verified online invoice closes RECEIVED requests of the active technician before completion effects', async () => {
    const s = fixture();
    await (s.finance as any).markInvoicePaidOnline(s.manager, s.invoice, 'customer-1', new Date());
    expect(s.order.status).toBe(ServiceOrderStatus.COMPLETED);
    const closed = s.manager.update.mock.calls.filter(([entity]) => entity === PartRequest);
    expect(closed).toHaveLength(1);
    expect(closed[0][1]).toMatchObject({
      serviceOrderId: 'order-1', technicianId: 'technician-new',
      status: expect.objectContaining({ value: [PartRequestStatus.RECEIVED] }),
    });
    expect(closed[0][2]).toMatchObject({ status: PartRequestStatus.COMPLETED });
    expect(s.events).toEqual(['order-completed', 'part-request-closed', 'completion-effects']);
  });

  it('confirmed cash invoice closes logical received parts inside the same transaction', async () => {
    const s = fixture();
    await s.finance.applyConfirmedCash(s.manager as never, {
      order: s.order as never, invoice: s.invoice as never,
      settlement: { id: 'settlement-1' } as never,
      actor: { id: 'customer-1', role: Role.CUSTOMER },
      now: new Date(),
    });
    const closed = s.manager.update.mock.calls.filter(([entity]) => entity === PartRequest);
    expect(closed).toHaveLength(1);
    expect(closed[0][1]).toMatchObject({ technicianId: 'technician-new' });
    expect(s.events).toEqual(['order-completed', 'part-request-closed', 'completion-effects']);
  });

  it('does not close any previous technician custody when there is no current active holder', async () => {
    const s = fixture(false);
    await (s.finance as any).markInvoicePaidOnline(s.manager, s.invoice, 'customer-1', new Date());
    expect(s.manager.update.mock.calls.filter(([entity]) => entity === PartRequest)).toHaveLength(0);
  });

  it('does not finalize parts before customer/technician completion request', async () => {
    const s = fixture(true, false);
    await (s.finance as any).markInvoicePaidOnline(s.manager, s.invoice, 'customer-1', new Date());
    expect(s.order.status).toBe(ServiceOrderStatus.UNDER_REPAIR);
    expect(s.manager.update.mock.calls.filter(([entity]) => entity === PartRequest)).toHaveLength(0);
  });

  it('does not run part closure twice for the same already-completed paid order', async () => {
    const s = fixture();
    await (s.finance as any).markInvoicePaidOnline(s.manager, s.invoice, 'customer-1', new Date());
    await (s.finance as any).markInvoicePaidOnline(s.manager, s.invoice, 'customer-1', new Date());
    expect(s.manager.update.mock.calls.filter(([entity]) => entity === PartRequest)).toHaveLength(1);
  });
});
