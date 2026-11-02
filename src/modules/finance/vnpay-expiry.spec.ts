import { describe, expect, it, vi } from 'vitest';
import { PaymentAttemptStatus, PaymentStatus, Role, ServiceOrderStatus, SupportCaseType } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { CashPaymentIntent } from './entities/cash-payment-intent.entity';
import { Payment } from './entities/payment.entity';
import { FinanceService } from './finance.service';
import {
  buildPaymentUrl, formatVnpayDate, isAbandonedVnpayAttempt, verifySignature, vnpayExpiry,
  VNPAY_EXPIRY_GRACE_MS, VNPAY_PAID_AFTER_EXPIRY, VNPAY_URL_EXPIRED, VNPAY_URL_TTL_MS,
} from './vnpay/vnpay.util';

const commandId = '7de9bf22-54ed-4a7f-af84-641706aac559';
const minutes = (n: number) => n * 60 * 1000;

describe('VNPay URL expiry (bug 39, PO 01/11/2026)', () => {
  it('expires 15 minutes after the create date and waits a 15 minute grace', () => {
    expect(VNPAY_URL_TTL_MS).toBe(minutes(15));
    expect(VNPAY_EXPIRY_GRACE_MS).toBe(minutes(15));
    const created = new Date('2026-11-01T02:50:30.400Z');
    expect(vnpayExpiry(created).toISOString()).toBe('2026-11-01T03:05:30.400Z');
  });

  it('writes vnp_ExpireDate in GMT+7 yyyyMMddHHmmss, 15 minutes after vnp_CreateDate, inside the signature', () => {
    const secret = 'TESTSECRET123';
    // 16:50 UTC is 23:50 in Vietnam, so the expiry rolls over to the next Vietnam day.
    const created = new Date('2026-10-31T16:50:00Z');
    const url = buildPaymentUrl({ paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html', tmnCode: 'TMN',
      hashSecret: secret, amount: 150000, txnRef: 'abc', orderInfo: 'x', returnUrl: 'https://api.example/return',
      ipAddr: '127.0.0.1', createdAt: created, expiresAt: vnpayExpiry(created) });
    const query = Object.fromEntries(new URL(url).searchParams.entries());
    expect(query.vnp_CreateDate).toBe('20261031235000');
    expect(query.vnp_ExpireDate).toBe('20261101000500');
    expect(query.vnp_ExpireDate).toBe(formatVnpayDate(new Date(+created + VNPAY_URL_TTL_MS)));
    expect(verifySignature(query, secret)).toBe(true);
    // A forged later expiry breaks the signature.
    expect(verifySignature({ ...query, vnp_ExpireDate: '20261101010500' }, secret)).toBe(false);
  });

  it('builds no vnp_ExpireDate when the attempt has none stored', () => {
    const url = buildPaymentUrl({ paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html', tmnCode: 'TMN',
      hashSecret: 's', amount: 150000, txnRef: 'abc', orderInfo: 'x', returnUrl: 'https://api.example/return',
      ipAddr: '127.0.0.1', expiresAt: null });
    expect(new URL(url).searchParams.has('vnp_ExpireDate')).toBe(false);
  });

  it('treats an attempt as abandoned only once the stored expiry plus the grace has passed', () => {
    const expiresAt = new Date('2026-11-01T03:05:00Z');
    expect(isAbandonedVnpayAttempt(expiresAt, new Date(+expiresAt - 1))).toBe(false);
    expect(isAbandonedVnpayAttempt(expiresAt, new Date(+expiresAt + minutes(14) + 59_999))).toBe(false);
    expect(isAbandonedVnpayAttempt(expiresAt, new Date(+expiresAt + minutes(15)))).toBe(true);
    expect(isAbandonedVnpayAttempt(expiresAt.toISOString(), new Date(+expiresAt + minutes(60)))).toBe(true);
  });

  it('never guesses an expiry for an attempt opened before it was stored', () => {
    const later = new Date('2030-01-01T00:00:00Z');
    expect(isAbandonedVnpayAttempt(null, later)).toBe(false);
    expect(isAbandonedVnpayAttempt(undefined, later)).toBe(false);
    expect(isAbandonedVnpayAttempt('not a date', later)).toBe(false);
  });
});

function setup(attempts: any[]) {
  const invoice = { id: 'invoice-1', serviceOrderId: 'order-1', grandTotal: 120_000, paymentStatus: PaymentStatus.UNPAID };
  const order = { id: 'order-1', bookingId: 'booking-1', status: ServiceOrderStatus.UNDER_REPAIR, completionRequestedAt: new Date() };
  const booking = { id: 'booking-1', customerId: 'customer-1', visitGroupId: null };
  const assignment = { technicianId: 'tech-1', serviceOrderId: 'order-1', isActive: true };
  const rows = new Map<string, any>(attempts.map(row => [row.id, row]));
  const save = vi.fn(async (entity: any, value: any) => {
    if (entity === Payment) { rows.set(value.id, value); return value; }
    return { id: 'intent-1', ...value };
  });
  const manager = {
    findOne: vi.fn(async (entity: any, options?: any) => entity === Invoice ? invoice : entity === ServiceOrder ? order :
      entity === Booking ? booking : entity === TechnicianAssignment ? assignment :
        entity === Payment ? rows.get(options?.where?.id) ?? null : null),
    findOneBy: vi.fn(async (entity: any) => entity === Invoice ? invoice : null),
    find: vi.fn(async (entity: any, options?: any) => entity !== Payment ? [] :
      [...rows.values()].filter(row => !options?.where?.status || row.status === options.where.status)),
    insert: vi.fn(async () => undefined),
    exists: vi.fn(async () => false),
    count: vi.fn(async () => 0),
    query: vi.fn(async () => []),
    queryRunner: { isTransactionActive: true },
    create: vi.fn((_entity: any, value: any) => value), save,
  };
  const service = Object.assign(Object.create(FinanceService.prototype), {
    dataSource: { transaction: async (callback: (value: any) => unknown) => callback(manager),
      getRepository: () => ({ findOne: async () => null, findOneBy: async () => null }) },
    config: { get: () => 'true' },
    auditLogService: { logWithManager: vi.fn(async () => undefined) },
    assertLegacyCollectionAllowed: vi.fn(async () => undefined),
  }) as FinanceService;
  return { service, manager, save, rows };
}

const vnpayAttempt = (expiresAt: Date | null) => ({ id: 'pay-1', invoiceId: 'invoice-1', purpose: 'invoice',
  provider: 'vnpay', status: PaymentAttemptStatus.PENDING, amount: 120_000, expiresAt, failureCode: null as string | null,
  requestedByUserId: 'customer-1' });
const customer = { id: 'customer-1', role: Role.CUSTOMER };

describe('cash after an abandoned VNPay attempt', () => {
  it('closes an attempt past expiry plus grace as expired and records the cash intent', async () => {
    const { service, manager, rows, save } = setup([vnpayAttempt(new Date(Date.now() - minutes(16)))]);
    const intent = await (service as any).createCashIntent('SOLO', 'order-1', { commandId }, customer);
    expect(intent).toMatchObject({ status: 'pending', customerDueVnd: 120_000 });
    expect(rows.get('pay-1')).toMatchObject({ status: PaymentAttemptStatus.CANCELLED, failureCode: VNPAY_URL_EXPIRED });
    expect(manager.findOne).toHaveBeenCalledWith(Payment, expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
    expect(manager.findOne).toHaveBeenCalledWith(Invoice, expect.objectContaining({ where: { id: 'invoice-1' }, lock: { mode: 'pessimistic_write' } }));
    expect(save).toHaveBeenCalledWith(CashPaymentIntent, expect.anything());
    expect((service as any).auditLogService.logWithManager).toHaveBeenCalledWith(manager,
      expect.objectContaining({ action: 'PAYMENT_URL_EXPIRED', resourceId: 'pay-1' }));
  });

  it('keeps the same 409 while the expiry plus grace has not passed', async () => {
    const { service, rows, save } = setup([vnpayAttempt(new Date(Date.now() - minutes(14)))]);
    await expect((service as any).createCashIntent('SOLO', 'order-1', { commandId }, customer))
      .rejects.toThrow('Có giao dịch thanh toán đang xử lý');
    expect(rows.get('pay-1').status).toBe(PaymentAttemptStatus.PENDING);
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps blocking an old attempt with no stored expiry', async () => {
    const { service, rows } = setup([vnpayAttempt(null)]);
    await expect((service as any).createCashIntent('SOLO', 'order-1', { commandId }, customer))
      .rejects.toThrow('Có giao dịch thanh toán đang xử lý');
    expect(rows.get('pay-1').status).toBe(PaymentAttemptStatus.PENDING);
  });

  it('closes an abandoned visit VNPay attempt under the visit lock and keeps a fresh one', async () => {
    const visit = { id: 'vgp-1', visitGroupId: 'group-1', rail: 'vnpay', status: 'pending', failureCode: null as string | null,
      expiresAt: new Date(Date.now() - minutes(31)) };
    const fresh = { id: 'vgp-2', visitGroupId: 'group-1', rail: 'vnpay', status: 'pending', failureCode: null as string | null,
      expiresAt: new Date() };
    const store = new Map<string, any>([[visit.id, visit], [fresh.id, fresh]]);
    const manager = {
      find: vi.fn(async () => [visit, fresh]),
      findOne: vi.fn(async (entity: any, options?: any) => entity === VisitGroupPayment ? store.get(options.where.id) : null),
      save: vi.fn(async (_entity: any, value: any) => value),
    };
    const { service } = setup([]);
    await (service as any).closeAbandonedVisitVnpayAttempts(manager, 'group-1', customer);
    expect(visit).toMatchObject({ status: 'cancelled', failureCode: VNPAY_URL_EXPIRED });
    expect(fresh.status).toBe('pending');
    expect(manager.save).toHaveBeenCalledOnce();
  });
});

describe('late VNPay success for an attempt closed as expired', () => {
  function ipnSetup(attempt: any) {
    const manager = {
      findOne: vi.fn(async (entity: any) => entity === Payment ? attempt : entity === Invoice
        ? { id: 'invoice-1', serviceOrderId: 'order-1', paymentStatus: PaymentStatus.PAID }
        : entity === ServiceOrder ? { id: 'order-1', bookingId: 'booking-1' }
          : entity === Booking ? { id: 'booking-1', customerId: 'customer-1' }
            : entity === TechnicianAssignment ? { technicianId: 'tech-1' } : null),
      update: vi.fn(async (_entity: any, _where: any, values: any) => { Object.assign(attempt, values); }),
    };
    const openCase = vi.fn(async () => ({ id: 'case-1' }));
    const service = Object.assign(Object.create(FinanceService.prototype), {
      dataSource: { transaction: async (callback: (value: any) => unknown) => callback(manager) },
      supportCasesService: { openCase },
      auditLogService: { logWithManager: vi.fn(async () => undefined) },
      logger: { warn: vi.fn() },
    }) as FinanceService;
    return { service, manager, openCase };
  }
  const success = { vnp_TxnRef: 'txn-1', vnp_Amount: '12000000', vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: '14000001' };

  it('flags the attempt and opens one support case without paying anything', async () => {
    const attempt = { ...vnpayAttempt(new Date()), status: PaymentAttemptStatus.CANCELLED, failureCode: VNPAY_URL_EXPIRED };
    const { service, openCase } = ipnSetup(attempt);
    const result = await (service as any).holdLateVnpayPayment('payment', 'pay-1', success);
    expect(result.RspCode).toBe('02');
    expect(attempt).toMatchObject({ status: PaymentAttemptStatus.CANCELLED, failureCode: VNPAY_PAID_AFTER_EXPIRY, providerReference: '14000001' });
    expect(openCase).toHaveBeenCalledOnce();
    expect(openCase).toHaveBeenCalledWith(expect.objectContaining({ caseType: SupportCaseType.OTHER,
      serviceOrderId: 'order-1', bookingId: 'booking-1', customerId: 'customer-1', technicianId: 'tech-1' }), expect.anything());
    // VNPay retries: the flag is already there, no second case.
    expect((await (service as any).holdLateVnpayPayment('payment', 'pay-1', success)).RspCode).toBe('02');
    expect(openCase).toHaveBeenCalledOnce();
  });

  it('ignores a late failure and refuses a wrong amount', async () => {
    const attempt = { ...vnpayAttempt(new Date()), status: PaymentAttemptStatus.CANCELLED, failureCode: VNPAY_URL_EXPIRED };
    const { service, openCase } = ipnSetup(attempt);
    expect((await (service as any).holdLateVnpayPayment('payment', 'pay-1', { ...success, vnp_ResponseCode: '24' })).RspCode).toBe('02');
    expect((await (service as any).holdLateVnpayPayment('payment', 'pay-1', { ...success, vnp_Amount: '100' })).RspCode).toBe('04');
    expect(attempt.failureCode).toBe(VNPAY_URL_EXPIRED);
    expect(openCase).not.toHaveBeenCalled();
  });
});
