import { describe, expect, it, vi } from 'vitest';
import { PaymentStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Payment } from './entities/payment.entity';
import { CashPaymentIntent } from './entities/cash-payment-intent.entity';
import { FinanceService } from './finance.service';

const commandId = '7de9bf22-54ed-4a7f-af84-641706aac559';

function setup(intent?: any) {
  const invoice = { id: 'invoice-1', serviceOrderId: 'order-1', grandTotal: 120_000,
    paymentStatus: PaymentStatus.UNPAID };
  const order = { id: 'order-1', bookingId: 'booking-1', status: ServiceOrderStatus.UNDER_REPAIR,
    completionRequestedAt: new Date() };
  const booking = { id: 'booking-1', customerId: 'customer-1', visitGroupId: null };
  const assignment = { technicianId: 'tech-1', serviceOrderId: 'order-1', isActive: true };
  const save = vi.fn(async (entity, value) => ({ id: entity === CashSettlement ? 'cash-1' : 'intent-1', ...value }));
  const manager = {
    findOne: vi.fn(async (entity) => entity === Invoice ? invoice : entity === ServiceOrder ? order :
      entity === Booking ? booking : entity === TechnicianAssignment ? assignment :
      entity === CashPaymentIntent ? intent ?? null : null),
    findOneBy: vi.fn(async (entity) => entity === Invoice ? invoice : entity === ServiceOrder ? order :
      entity === Booking ? booking : entity === CashPaymentIntent ? intent ?? null : null),
    findOneOrFail: vi.fn(async (entity) => entity === Invoice ? invoice : entity === ServiceOrder ? order : null),
    find: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    count: vi.fn(async () => 0),
    insert: vi.fn(async () => undefined),
    query: vi.fn(async () => []),
    create: vi.fn((_entity, value) => value), save,
    queryRunner: { isTransactionActive: true },
  };
  const service = Object.assign(Object.create(FinanceService.prototype), {
    dataSource: { transaction: async (callback: (value: any) => unknown) => callback(manager),
      getRepository: () => ({ findOneBy: async () => intent ?? null, findOne: async () => null }) },
    config: { get: () => 'true' },
    auditLogService: { logWithManager: vi.fn(async () => undefined) },
    assertLegacyCollectionAllowed: vi.fn(async () => undefined),
    assertFundedCollectionReady: vi.fn(async () => undefined),
    applyConfirmedCash: vi.fn(async () => undefined),
  }) as FinanceService;
  return { service, manager, save, invoice, order, booking };
}

describe('cash-first intent', () => {
  it('records customer-owned intent without paying or creating any collection', async () => {
    const { service, manager, save, invoice, order } = setup();
    const result = await (service as any).createCashIntent('SOLO', order.id, { commandId },
      { id: 'customer-1', role: Role.CUSTOMER });
    expect(result).toMatchObject({ status: 'pending', customerDueVnd: 120_000, technicianId: 'tech-1' });
    expect(invoice.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(order.status).toBe(ServiceOrderStatus.UNDER_REPAIR);
    expect(save).toHaveBeenCalledOnce();
    expect(manager.findOne).toHaveBeenCalledWith(CashSettlement, expect.anything());
    expect(manager.find).toHaveBeenCalledWith(Payment, expect.anything());
  });

  it('rejects a different customer before writing intent', async () => {
    const { service, save } = setup();
    await expect((service as any).createCashIntent('SOLO', 'order-1', { commandId },
      { id: 'another-customer', role: Role.CUSTOMER })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps new customer-intent mutations closed before client cutover', async () => {
    const { service, save } = setup();
    (service as any).config = { get: () => 'false' };
    await expect((service as any).createCashIntent('SOLO', 'order-1', { commandId },
      { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses technician receipt without a matching customer intent', async () => {
    const { service, save } = setup();
    await expect((service as any).receiveCashIntent('SOLO', 'order-1', {
      intentId: 'missing', commandId, receivedAmountVnd: 120_000,
    }, { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('calls the existing cash finalization exactly once after a matching technician receipt', async () => {
    const pending = { id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', customerId: 'customer-1',
      technicianId: 'tech-1', status: 'pending', grossVnd: 120_000, customerDueVnd: 120_000,
      voucherReservationId: null, allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1',
        originalGrossVnd: 120_000, customerDueVnd: 120_000 }] };
    const { service, manager } = setup(pending);
    const result = await (service as any).receiveCashIntent('SOLO', 'order-1', {
      intentId: 'intent-1', commandId, receivedAmountVnd: 120_000,
    }, { id: 'tech-1', role: Role.TECHNICIAN });
    expect(result.status).toBe('received');
    expect((service as any).applyConfirmedCash).toHaveBeenCalledOnce();
    expect(manager.save).toHaveBeenCalledWith(CashSettlement, expect.objectContaining({
      status: 'confirmed', declaredAmount: 120_000, confirmedByCustomerId: 'customer-1',
    }));
  });

  it('lets the owner cancel an unreceived intent without a financial mutation', async () => {
    const pending = { id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', customerId: 'customer-1',
      technicianId: 'tech-1', status: 'pending', cancelCommandId: null };
    const { service, manager } = setup(pending);
    const result = await (service as any).cancelCashIntent('SOLO', 'order-1',
      { intentId: 'intent-1', commandId }, { id: 'customer-1', role: Role.CUSTOMER });
    expect(result.status).toBe('cancelled');
    expect(manager.save).toHaveBeenCalledWith(CashPaymentIntent, expect.objectContaining({ status: 'cancelled' }));
    expect((service as any).applyConfirmedCash).not.toHaveBeenCalled();
  });

  it('blocks another payment rail while a cash intent is active', async () => {
    const pending = { id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', status: 'pending' };
    const { service, manager } = setup(pending);
    await expect((service as any).assertNoActiveCashIntent(manager, 'SOLO', 'order-1')).rejects.toThrow();
  });

  it('freezes funded cash at customer NET while preserving invoice gross', async () => {
    const { service, invoice, order, save } = setup();
    (service as any).quoteVoucherRail = vi.fn(async () => ({ total: {
      originalGrossVnd: 120_000, customerDueVnd: 90_000,
    } }));
    const intent = await (service as any).createCashIntent('SOLO', order.id,
      { commandId, voucherReservationId: 'reservation-1' }, { id: 'customer-1', role: Role.CUSTOMER });
    expect(intent).toMatchObject({ grossVnd: 120_000, customerDueVnd: 90_000,
      allocations: [{ originalGrossVnd: 120_000, customerDueVnd: 90_000 }] });
    expect(invoice.grandTotal).toBe(120_000);
    expect(save).toHaveBeenCalledOnce();
  });

  it('refuses cash intent while an invoice provider attempt is unresolved', async () => {
    const { service, manager, save } = setup();
    manager.find.mockResolvedValue([{ status: 'pending' }] as never);
    await expect((service as any).createCashIntent('SOLO', 'order-1', { commandId },
      { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a wrong physical amount without creating cash evidence', async () => {
    const pending = { id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', customerId: 'customer-1',
      technicianId: 'tech-1', status: 'pending', grossVnd: 120_000, customerDueVnd: 120_000,
      voucherReservationId: null, allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1',
        originalGrossVnd: 120_000, customerDueVnd: 120_000 }] };
    const { service, manager } = setup(pending);
    await expect((service as any).receiveCashIntent('SOLO', 'order-1', {
      intentId: 'intent-1', commandId, receivedAmountVnd: 119_000,
    }, { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
    expect((service as any).applyConfirmedCash).not.toHaveBeenCalled();
  });

  it('does not let funded legacy customer confirmation act as a third approval', async () => {
    const { service } = setup();
    (service as any).dataSource.getRepository = () => ({ exists: async () => true });
    (service as any).confirmVoucherCash = vi.fn();
    await expect(service.confirmVoucherCashByReservation('order-1', { agreed: true } as any,
      { id: 'customer-1', role: Role.CUSTOMER }, 'reservation-1')).rejects.toThrow();
    expect((service as any).confirmVoucherCash).not.toHaveBeenCalled();
  });

  it('returns the same receipt only for the exact technician command and evidence', async () => {
    const received = { id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', technicianId: 'tech-1',
      status: 'received', receiptCommandId: commandId, receivedAmountVnd: 120_000,
      receiptEvidenceUrl: 'evidence-1' };
    const { service, manager } = setup(received);
    const actor = { id: 'tech-1', role: Role.TECHNICIAN };
    const request = { intentId: 'intent-1', commandId, receivedAmountVnd: 120_000, receiptEvidenceUrl: 'evidence-1' };
    expect(await (service as any).receiveCashIntent('SOLO', 'order-1', request, actor)).toBe(received);
    await expect((service as any).receiveCashIntent('SOLO', 'order-1',
      { ...request, receiptEvidenceUrl: 'different' }, actor)).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
  });
});
