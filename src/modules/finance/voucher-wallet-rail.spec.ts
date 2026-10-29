import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from './finance.service';
import { commitVerifiedVoucherFunding } from '../vouchers/voucher-settlement-evidence';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { Payment } from './entities/payment.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { VoucherPaymentLink } from '../vouchers/entities/voucher-funding.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { createHmac } from 'crypto';
import { bindVoucherPaymentLink } from '../vouchers/voucher-payment-link';
import { commitConfirmedCashVoucherFunding } from '../vouchers/voucher-cash-credit';
import { recordSignedVoucherVnpayOutcome } from '../vouchers/voucher-provider-ledger';

vi.mock('../vouchers/voucher-settlement-evidence', () => ({ commitVerifiedVoucherFunding: vi.fn() }));
vi.mock('../vouchers/voucher-payment-link', () => ({ bindVoucherPaymentLink: vi.fn(async () => ({
  id: 'zero-link-1', customerId: 'customer-1', scopeId: 'order-1', scopeKind: 'SOLO',
  customerDueVnd: 0, createdAt: new Date('2026-10-26T15:00:00Z'),
})) }));
vi.mock('../vouchers/voucher-cash-credit', () => ({ commitConfirmedCashVoucherFunding: vi.fn() }));
vi.mock('../vouchers/voucher-provider-ledger', () => ({ recordSignedVoucherVnpayOutcome: vi.fn() }));
vi.mock('../vouchers/voucher-funding-lock', () => ({ lockVoucherFundingReservation: vi.fn() }));
vi.mock('../part-requests/part-custody.policy', async importOriginal => ({
  ...(await importOriginal<typeof import('../part-requests/part-custody.policy')>()),
  lockCustodyTechnician: vi.fn(),
}));

const actor = { id: 'customer-1', role: 'customer' };
const quote = { total: { originalGrossVnd: 100000, customerDueVnd: 50000 },
  invoices: [{ invoiceId: 'invoice-1', originalGrossVnd: 100000, customerDueVnd: 50000 }] };

function serviceFor(scope: 'SOLO' | 'VISIT_GROUP') {
  const invoice = { id: 'invoice-1', serviceOrderId: 'order-1', grandTotal: 100000, paymentStatus: 'unpaid' };
  const booking = { id: 'booking-1', customerId: actor.id };
  const order = { id: 'order-1', bookingId: booking.id, code: 'O1', status: 'completed',
    completionRequestedAt: new Date('2026-10-26T15:00:00Z') };
  const manager = {
    queryRunner: { isTransactionActive: true },
    // Exercise the real stopped-collection guard against this completed, billed child.
    find: vi.fn(async (entity: unknown) => entity === VisitGroupItem
      ? [{ id: 'item-1', groupId: 'group-1', bookingId: booking.id, sequence: 1, outcome: 'succeeded' }]
      : entity === Invoice ? [invoice] : []),
    findBy: vi.fn(async (entity: unknown) => entity === Booking ? [booking] : entity === ServiceOrder ? [order] : []),
    findOne: vi.fn(async (entity: unknown) => entity === Invoice ? invoice
      : entity === ServiceOrder ? order
        : entity === TechnicianAssignment ? { technicianId: 'technician-1' }
        : entity === Booking ? booking : null),
    findOneBy: vi.fn(async (entity: unknown) => entity === Invoice ? invoice
      : entity === ServiceOrder ? order
        : entity === Booking ? booking
          : entity === VisitGroup ? { id: 'group-1', customerId: actor.id } : null),
    findOneOrFail: vi.fn(async () => invoice),
    update: vi.fn(),
    insert: vi.fn(),
    query: vi.fn(async () => [{ now: new Date('2026-10-26T15:01:00Z') }]),
    create: vi.fn((_entity, value) => value),
    save: vi.fn(async (_entity, value) => ({ ...value, id: 'payment-1' })),
  };
  const wallet = { apply: vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111111', balanceAfter: 100000 })) };
  const redeemSettled = vi.fn();
  const service = Object.assign(Object.create(FinanceService.prototype), {
    dataSource: { transaction: (work: (manager: unknown) => unknown) => work(manager) },
    customerWalletService: wallet,
    vouchersService: { redeemSettled },
    quoteVoucherRail: vi.fn(async () => quote),
    bindVoucherPaymentAfterRecord: vi.fn(async () => ({ id: 'link-1' })),
    markInvoicePaidOnline: vi.fn(),
    auditLogService: { logWithManager: vi.fn() },
    visitAccess: vi.fn(async () => ({ customerId: actor.id })),
    readyVisitCharge: vi.fn(async () => ({ ready: true, waiting: 0, paid: false,
      total: 100000, allocations: [{ invoiceId: invoice.id, serviceOrderId: invoice.serviceOrderId, amount: 100000 }] })),
    cancelOpenVisitPayments: vi.fn(),
  }) as FinanceService;
  return { service, manager, wallet, redeemSettled, scope };
}

describe('voucher wallet money transaction', () => {
  it.each(['SOLO', 'VISIT_GROUP'] as const)('%s debits server due and commits funding before redeem', async (scope) => {
    const { service, manager, wallet, redeemSettled } = serviceFor(scope);
    if (scope === 'SOLO') await service.payInvoiceWithWallet('invoice-1', actor, 'reservation-1');
    else await service.payVisitWithWallet('group-1', actor, 'reservation-1');
    expect(wallet.apply).toHaveBeenCalledWith(manager, expect.objectContaining({ amount: 50000 }));
    expect(manager.save).toHaveBeenCalledWith(scope === 'SOLO' ? Payment : VisitGroupPayment,
      expect.objectContaining({ amount: 50000 }));
    expect(service.bindVoucherPaymentAfterRecord).toHaveBeenCalledWith(manager,
      expect.objectContaining({ reservationId: 'reservation-1', rail: 'WALLET', sourceId: 'payment-1' }));
    expect(commitVerifiedVoucherFunding).toHaveBeenCalledWith(manager, 'payment-1');
    expect(redeemSettled).toHaveBeenCalledWith('payment-1', manager);
  });
  it('rejects wallet checkout when quota redemption rejects in its transaction', async () => {
    const { service, redeemSettled } = serviceFor('SOLO');
    redeemSettled.mockRejectedValueOnce(new Error('voucher quota exhausted'));
    await expect(service.payInvoiceWithWallet('invoice-1', actor, 'reservation-1'))
      .rejects.toThrow('voucher quota exhausted');
  });
});

describe('voucher VNPay initiation', () => {
  it.each(['SOLO', 'VISIT_GROUP'] as const)('%s signs server due after binding its pending attempt', async (scope) => {
    const { service, manager } = serviceFor(scope);
    Object.assign(service, {
      getPaymentMode: vi.fn(async () => 'LIVE'),
      config: { get: (key: string) => key.includes('URL') ? 'https://pay.example/checkout' : 'configured' },
    });
    const result = scope === 'SOLO'
      ? await service.createVnpayPaymentUrl('invoice-1', actor, '127.0.0.1', 'web', undefined, 'reservation-1')
      : await service.createVisitVnpayUrl('group-1', actor, '127.0.0.1', 'web', undefined, 'reservation-1');
    expect(manager.save).toHaveBeenCalledWith(scope === 'SOLO' ? Payment : VisitGroupPayment,
      expect.objectContaining({ amount: 50000, status: 'pending' }));
    expect(service.bindVoucherPaymentAfterRecord).toHaveBeenCalledWith(manager,
      expect.objectContaining({ rail: 'VNPAY', sourceId: 'payment-1' }));
    expect(result.paymentUrl).toContain('5000000');
  });
});

describe('voucher VNPay signed callback dispatch', () => {
  it('routes a funded SOLO attempt through the evidence adapter', async () => {
    const { service } = serviceFor('SOLO');
    const payment = { id: 'payment-1', idempotencyKey: 'txn-1', status: 'pending', amount: 50000 };
    const query: Record<string, string> = { vnp_TxnRef: 'txn-1', vnp_Amount: '5000000',
      vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TmnCode: 'merchant',
      vnp_PayDate: '20261027001000' };
    // The callback must enter only after the existing HMAC check.
    const sorted = Object.keys(query).sort().map(key => `${key}=${encodeURIComponent(query[key]).replace(/%20/g, '+')}`).join('&');
    query.vnp_SecureHash = createHmac('sha512', 'secret').update(sorted).digest('hex');
    const funded = vi.fn(async () => ({ RspCode: '00', Message: 'Confirm Success' }));
    Object.assign(service, {
      config: { get: () => 'secret' },
      paymentRepository: { findOne: vi.fn(async () => payment) },
      dataSource: { getRepository: (entity: unknown) => entity === VoucherPaymentLink
        ? { findOne: vi.fn(async () => ({ reservationId: 'reservation-1' })) } : null },
      handleVoucherVnpayIpn: funded,
      applyVerification: vi.fn(() => { throw new Error('gross path used'); }),
    });
    expect(await service.handleVnpayIpn(query)).toMatchObject({ RspCode: '00' });
    expect(funded).toHaveBeenCalled();
  });
});

describe('voucher cash declaration', () => {
  const technician = { id: 'technician-1', role: 'technician' };
  it.each(['SOLO', 'VISIT_GROUP'] as const)('%s binds server net cash and leaves funding uncommitted', async scope => {
    vi.mocked(commitVerifiedVoucherFunding).mockClear();
    const { service, manager } = serviceFor(scope);
    Object.assign(service, { auditLogService: { logWithManager: vi.fn() } });
    const result = scope === 'SOLO'
      ? await service.declareCashSettlement('order-1', { declaredAmount: 50000 }, technician, 'reservation-1')
      : await service.declareVisitCash('group-1', { declaredAmount: 50000 }, technician, 'reservation-1');
    expect(manager.save).toHaveBeenCalledWith(scope === 'SOLO' ? CashSettlement : VisitGroupPayment,
      expect.objectContaining({ status: 'pending_confirmation' }));
    expect(service.bindVoucherPaymentAfterRecord).toHaveBeenCalledWith(manager,
      expect.objectContaining({ rail: 'CASH', sourceId: 'payment-1' }));
    expect(commitVerifiedVoucherFunding).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
  it('refuses a technician amount that differs from the frozen server due', async () => {
    const { service, manager } = serviceFor('SOLO');
    await expect(service.declareCashSettlement('order-1', { declaredAmount: 100000 },
      technician, 'reservation-1')).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
    expect(service.bindVoucherPaymentAfterRecord).not.toHaveBeenCalled();
  });
  it.each(['SOLO', 'VISIT_GROUP'] as const)('%s reuses a matching cash declaration without another record', async scope => {
    const { service, manager } = serviceFor(scope);
    const originalFindOne = manager.findOne;
    manager.findOne = vi.fn(async (entity: unknown) => entity === CashSettlement
      ? { id: 'cash-1', serviceOrderId: 'order-1', status: 'pending_confirmation',
        declaredByTechnicianId: technician.id, declaredAmount: 50000 }
      : entity === VisitGroupPayment ? { id: 'cash-1', visitGroupId: 'group-1', rail: 'cash',
        status: 'pending_confirmation', requestedByUserId: technician.id, amount: 50000,
        allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1', amount: 50000 }] }
        : originalFindOne(entity as never)) as any;
    const result = scope === 'SOLO'
      ? await service.declareCashSettlement('order-1', { declaredAmount: 50000 }, technician, 'reservation-1')
      : await service.declareVisitCash('group-1', { declaredAmount: 50000 }, technician, 'reservation-1');
    expect(manager.save).not.toHaveBeenCalled();
    expect(service.bindVoucherPaymentAfterRecord).toHaveBeenCalledWith(manager,
      expect.objectContaining({ sourceId: 'cash-1', rail: 'CASH' }));
    expect(result).toBeTruthy();
  });
});

describe('verified zero-due closeout', () => {
  it.each(['SOLO', 'VISIT_GROUP'] as const)('%s closes without a provider or wallet debit', async scope => {
    const { service, manager, wallet, redeemSettled } = serviceFor(scope);
    vi.mocked(bindVoucherPaymentLink).mockResolvedValueOnce({ id: 'zero-link-1', customerId: actor.id,
      scopeId: scope === 'SOLO' ? 'order-1' : 'group-1', scopeKind: scope,
      customerDueVnd: 0, createdAt: new Date('2026-10-26T15:00:00Z') } as never);
    Object.assign(service, { quoteVoucherRail: vi.fn(async () => ({
      total: { originalGrossVnd: 100000, customerDueVnd: 0 },
      invoices: [{ invoiceId: 'invoice-1', originalGrossVnd: 100000, customerDueVnd: 0 }],
    })) });
    await service.closeVoucherZeroDue(scope, scope === 'SOLO' ? 'invoice-1' : 'group-1', actor, 'reservation-1');
    expect(bindVoucherPaymentLink).toHaveBeenCalledWith(manager, 'reservation-1', 'ZERO');
    expect(wallet.apply).not.toHaveBeenCalled();
    expect(commitVerifiedVoucherFunding).toHaveBeenCalledWith(manager, 'zero-link-1');
    expect(redeemSettled).toHaveBeenCalledWith('zero-link-1', manager);
  });
});

describe('voucher cash customer confirmation', () => {
  it.each(['SOLO', 'VISIT_GROUP'] as const)('%s credits the company share only after customer confirmation', async scope => {
    const { service, manager, redeemSettled } = serviceFor(scope);
    const link = { reservationId: 'reservation-1', rail: 'CASH', scopeKind: scope,
      scopeId: scope === 'SOLO' ? 'order-1' : 'group-1', customerId: actor.id,
      customerDueVnd: 50000, originalGrossVnd: 100000,
      cashSettlementId: scope === 'SOLO' ? 'payment-1' : null,
      visitGroupPaymentId: scope === 'VISIT_GROUP' ? 'payment-1' : null,
      allocationSnapshot: [{ invoiceId: 'invoice-1', originalGrossVnd: 100000, customerDueVnd: 50000 }],
    };
    const cash = { id: 'payment-1', serviceOrderId: 'order-1', status: 'pending_confirmation',
      declaredAmount: 50000, declaredByTechnicianId: 'technician-1' };
    const groupPayment = { id: 'payment-1', visitGroupId: 'group-1', rail: 'cash',
      status: 'pending_confirmation', amount: 50000, requestedByUserId: 'technician-1',
      requestedAt: new Date(), allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1', amount: 50000 }] };
    manager.findOneBy = vi.fn(async (entity: unknown) => entity === VoucherPaymentLink ? link
      : entity === Booking ? { id: 'booking-1', customerId: actor.id } : null) as typeof manager.findOneBy;
    manager.findOne = vi.fn(async (entity: unknown) => entity === CashSettlement ? cash
      : entity === VisitGroupPayment ? groupPayment
        : entity === Invoice ? { id: 'invoice-1', serviceOrderId: 'order-1', grandTotal: 100000, paymentStatus: 'unpaid' }
          : entity === ServiceOrder ? { id: 'order-1', bookingId: 'booking-1' } : null) as typeof manager.findOne;
    Object.assign(service, { walletService: {}, applyConfirmedCash: vi.fn(),
      openCashMismatchCase: vi.fn() });
    vi.mocked(commitConfirmedCashVoucherFunding).mockClear();
    if (scope === 'SOLO') await (service as any).confirmVoucherCash('order-1', { agreed: true }, actor, 'reservation-1');
    else await (service as any).confirmVoucherVisitCash('group-1', { agreed: true }, actor, 'reservation-1');
    expect(commitConfirmedCashVoucherFunding).toHaveBeenCalledWith(manager, 'reservation-1', {});
    expect(redeemSettled).toHaveBeenCalledWith('payment-1', manager);
    expect(service.applyConfirmedCash).toHaveBeenCalledWith(manager,
      expect.objectContaining({ collectedAmount: 50000 }));
  });
  it.each(['SOLO', 'VISIT_GROUP'] as const)('%s duplicate confirmation does not credit twice', async scope => {
    const { service, manager, redeemSettled } = serviceFor(scope);
    const link = { reservationId: 'reservation-1', rail: 'CASH', scopeKind: scope,
      scopeId: scope === 'SOLO' ? 'order-1' : 'group-1', customerId: actor.id,
      customerDueVnd: 50000, originalGrossVnd: 100000,
      cashSettlementId: scope === 'SOLO' ? 'cash-1' : null,
      visitGroupPaymentId: scope === 'VISIT_GROUP' ? 'cash-1' : null };
    manager.findOneBy = vi.fn(async (entity: unknown) => entity === VoucherPaymentLink ? link
      : entity === Booking ? { id: 'booking-1', customerId: actor.id } : null) as any;
    manager.findOne = vi.fn(async (entity: unknown) => entity === CashSettlement
      ? { id: 'cash-1', serviceOrderId: 'order-1', status: 'confirmed', declaredAmount: 50000 }
      : entity === VisitGroupPayment ? { id: 'cash-1', visitGroupId: 'group-1', rail: 'cash',
        status: 'verified', amount: 50000 }
        : entity === Invoice ? { id: 'invoice-1', grandTotal: 100000 }
          : entity === ServiceOrder ? { id: 'order-1', bookingId: 'booking-1' } : null) as any;
    Object.assign(service, { walletService: {} });
    vi.mocked(commitConfirmedCashVoucherFunding).mockClear();
    if (scope === 'SOLO') await (service as any).confirmVoucherCash('order-1', { agreed: true }, actor, 'reservation-1');
    else await (service as any).confirmVoucherVisitCash('group-1', { agreed: true }, actor, 'reservation-1');
    expect(commitConfirmedCashVoucherFunding).not.toHaveBeenCalled();
    expect(redeemSettled).not.toHaveBeenCalled();
  });
});

describe('voucher provider evidence and settlement', () => {
  it('retains a missing PayDate decision without marking an invoice paid', async () => {
    const { service, manager, redeemSettled } = serviceFor('SOLO');
    vi.mocked(recordSignedVoucherVnpayOutcome).mockResolvedValueOnce({ decision: 'QUARANTINE',
      providerReference: null, providerPaidAt: null });
    Object.assign(service, { config: { get: (key: string) => key === 'VNPAY_TMN_CODE' ? 'merchant' : 'secret' },
      logger: { error: vi.fn() } });
    const result = await (service as any).handleVoucherVnpayIpn('reservation-1', { vnp_TxnRef: 'txn-1' });
    expect(result.RspCode).toBe('00');
    expect(recordSignedVoucherVnpayOutcome).toHaveBeenCalledWith(manager, 'reservation-1',
      expect.objectContaining({ vnp_TxnRef: 'txn-1' }), 'merchant', 'secret');
    expect((service as any).markInvoicePaidOnline).not.toHaveBeenCalled();
    expect(redeemSettled).not.toHaveBeenCalled();
  });

  it('settles a signed SOLO PayDate through the same payment transaction', async () => {
    const { service, manager, redeemSettled } = serviceFor('SOLO');
    const paidAt = new Date('2026-10-26T15:02:00Z');
    const link = { rail: 'VNPAY', scopeKind: 'SOLO', paymentId: 'payment-1',
      customerDueVnd: 50000, providerTxnRef: 'txn-1',
      allocationSnapshot: [{ invoiceId: 'invoice-1', originalGrossVnd: 100000 }] };
    manager.findOneBy = vi.fn(async (entity: unknown) => entity === VoucherPaymentLink ? link : null) as any;
    manager.findOne = vi.fn(async (entity: unknown) => entity === VoucherPaymentLink ? link
      : entity === Payment ? { id: 'payment-1', status: 'pending', invoiceId: 'invoice-1', requestedByUserId: actor.id }
        : entity === Invoice ? { id: 'invoice-1', grandTotal: 100000, paymentStatus: 'unpaid' } : null) as any;
    vi.mocked(recordSignedVoucherVnpayOutcome).mockResolvedValueOnce({ decision: 'SETTLE',
      providerReference: 'provider-1', providerPaidAt: paidAt });
    vi.mocked(commitVerifiedVoucherFunding).mockClear();
    Object.assign(service, { config: { get: (key: string) => key === 'VNPAY_TMN_CODE' ? 'merchant' : 'secret' },
      logger: { error: vi.fn() } });
    const result = await (service as any).handleVoucherVnpayIpn('reservation-1', {
      vnp_TxnRef: 'txn-1', vnp_Amount: '5000000' });
    expect(result.RspCode).toBe('00');
    expect((service as any).markInvoicePaidOnline).toHaveBeenCalledWith(manager,
      expect.objectContaining({ id: 'invoice-1' }), actor.id, paidAt);
    expect(commitVerifiedVoucherFunding).toHaveBeenCalledWith(manager, 'payment-1');
    expect(redeemSettled).toHaveBeenCalledWith('payment-1', manager);
  });

  it('settles a signed VISIT_GROUP PayDate with a net child payment', async () => {
    const { service, manager, redeemSettled } = serviceFor('VISIT_GROUP');
    const paidAt = new Date('2026-10-26T15:02:00Z');
    const link = { rail: 'VNPAY', scopeKind: 'VISIT_GROUP', visitGroupPaymentId: 'payment-1',
      customerDueVnd: 50000, providerTxnRef: 'txn-1',
      allocationSnapshot: [{ invoiceId: 'invoice-1', originalGrossVnd: 100000, customerDueVnd: 50000 }] };
    manager.findOne = vi.fn(async (entity: unknown) => entity === VoucherPaymentLink ? link
      : entity === VisitGroupPayment ? { id: 'payment-1', status: 'pending', visitGroupId: 'group-1',
        idempotencyKey: 'txn-1', requestedByUserId: actor.id, requestedAt: paidAt,
        allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1', amount: 50000 }] }
        : entity === Invoice ? { id: 'invoice-1', serviceOrderId: 'order-1', grandTotal: 100000,
          paymentStatus: 'unpaid' } : null) as typeof manager.findOne;
    vi.mocked(recordSignedVoucherVnpayOutcome).mockResolvedValueOnce({ decision: 'SETTLE',
      providerReference: 'provider-1', providerPaidAt: paidAt });
    vi.mocked(commitVerifiedVoucherFunding).mockClear();
    Object.assign(service, { config: { get: (key: string) => key === 'VNPAY_TMN_CODE' ? 'merchant' : 'secret' },
      logger: { error: vi.fn() } });
    const result = await (service as any).handleVoucherVnpayIpn('reservation-1', {
      vnp_TxnRef: 'txn-1', vnp_Amount: '5000000' });
    expect(result.RspCode).toBe('00');
    expect(manager.save).toHaveBeenCalledWith(Payment, expect.objectContaining({ amount: 50000 }));
    expect((service as any).markInvoicePaidOnline).toHaveBeenCalledWith(manager,
      expect.objectContaining({ id: 'invoice-1' }), actor.id, paidAt);
    expect(commitVerifiedVoucherFunding).toHaveBeenCalledWith(manager, 'payment-1');
    expect(redeemSettled).toHaveBeenCalledWith('payment-1', manager);
  });
  it.each(['SOLO', 'VISIT_GROUP'] as const)('%s duplicate paid IPN does not credit twice', async scope => {
    const { service, manager, redeemSettled } = serviceFor(scope);
    const paidAt = new Date('2026-10-26T15:02:00Z');
    const link = { rail: 'VNPAY', scopeKind: scope, paymentId: scope === 'SOLO' ? 'payment-1' : null,
      visitGroupPaymentId: scope === 'VISIT_GROUP' ? 'payment-1' : null,
      customerDueVnd: 50000, providerTxnRef: 'txn-1' };
    manager.findOne = vi.fn(async (entity: unknown) => entity === VoucherPaymentLink ? link
      : entity === Payment || entity === VisitGroupPayment ? { id: 'payment-1', status: 'verified' } : null) as typeof manager.findOne;
    vi.mocked(recordSignedVoucherVnpayOutcome).mockResolvedValueOnce({ decision: 'SETTLE',
      providerReference: 'provider-1', providerPaidAt: paidAt });
    vi.mocked(commitVerifiedVoucherFunding).mockClear();
    Object.assign(service, { config: { get: (key: string) => key === 'VNPAY_TMN_CODE' ? 'merchant' : 'secret' },
      logger: { error: vi.fn() } });
    expect(await (service as any).handleVoucherVnpayIpn('reservation-1', {
      vnp_TxnRef: 'txn-1', vnp_Amount: '5000000' })).toMatchObject({ RspCode: '00' });
    expect(commitVerifiedVoucherFunding).not.toHaveBeenCalled();
    expect(redeemSettled).not.toHaveBeenCalled();
  });
});
