import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import {
  CashSettlementStatus,
  CommissionDueStatus,
  PaymentAttemptStatus,
  PaymentMode,
  PaymentStatus,
  Role,
  ServiceOrderStatus,
} from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { CashSettlementConfirmationDto, CashSettlementDeclarationDto, InitiatePaymentDto } from './dto';
import { Payment } from './entities/payment.entity';
import { PlatformDue } from './entities/platform-due.entity';
import { FinanceService } from './finance.service';

const actor = (id: string, role: Role) => ({ id, role });

const paymentDto = (key: string): InitiatePaymentDto =>
  Object.assign(new InitiatePaymentDto(), { idempotencyKey: key });

const makeFinanceService = (options: {
  invoice?: Invoice;
  order?: ServiceOrder;
  booking?: Booking;
  assignment?: TechnicianAssignment;
  settlement?: CashSettlement | null;
  paymentByKey?: Payment | null;
}) => {
  const invoice = options.invoice;
  const order = options.order;
  const booking = options.booking;
  const assignment = options.assignment;
  const settlement = options.settlement;

  const invoiceRepository = {
    findOne: vi.fn().mockResolvedValue(invoice),
    findOneBy: vi.fn().mockResolvedValue(invoice),
    save: vi.fn(async (value) => value),
  };
  const serviceOrderRepository = {
    findOne: vi.fn().mockResolvedValue(order),
    findOneBy: vi.fn().mockResolvedValue(order),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const bookingRepository = { findOneBy: vi.fn().mockResolvedValue(booking) };
  const assignmentRepository = { findOne: vi.fn().mockResolvedValue(assignment) };
  const cashSettlementRepository = {
    findOne: vi.fn().mockResolvedValue(settlement),
  };
  const commissionDueRepository = { find: vi.fn(), findOne: vi.fn() };
  const platformDueRepository = { findAndCount: vi.fn() };
  const paymentRepository = {
    findOne: vi.fn(),
    create: vi.fn((val) => val),
    save: vi.fn(async (val) => val),
  };
  const supportCasesService = { openCase: vi.fn().mockResolvedValue(undefined) };
  const auditLogService = { logWithManager: vi.fn().mockResolvedValue(undefined) };
  const configService = { getString: vi.fn().mockResolvedValue('DEMO') };
  const verificationPort = { verify: vi.fn() };
  const nestConfigService = { get: vi.fn() };

  const repositories = new Map<unknown, any>([
    [Invoice, invoiceRepository],
    [ServiceOrder, serviceOrderRepository],
    [Booking, { findOne: vi.fn().mockResolvedValue(booking) }],
    [TechnicianAssignment, { findOne: vi.fn().mockResolvedValue(assignment) }],
    [CashSettlement, cashSettlementRepository],
    [CommissionDue, commissionDueRepository],
    [Payment, paymentRepository],
    [PlatformDue, platformDueRepository],
  ]);

  const manager = {
    getRepository: vi.fn((entity: unknown) => repositories.get(entity)),
    findOne: vi.fn(async (entity: unknown) => {
      if (entity === Booking) return booking;
      if (entity === TechnicianAssignment) return assignment;
      if (entity === ServiceOrder) return order;
      return null;
    }),
  };
  const dataSource = {
    transaction: vi.fn(async (callback: (value: typeof manager) => unknown) =>
      callback(manager),
    ),
  };

  const service = new FinanceService(
    invoiceRepository as any,
    serviceOrderRepository as any,
    bookingRepository as any,
    assignmentRepository as any,
    cashSettlementRepository as any,
    commissionDueRepository as any,
    paymentRepository as any,
    platformDueRepository as any,
    dataSource as any,
    configService as any,
    supportCasesService as any,
    auditLogService as any,
    verificationPort as any,
    nestConfigService as any,
    {} as any,
  );

  return {
    service,
    manager,
    repositories,
    invoiceRepository,
    serviceOrderRepository,
    cashSettlementRepository,
    commissionDueRepository,
    paymentRepository,
    platformDueRepository,
    supportCasesService,
    auditLogService,
    verificationPort,
    nestConfigService,
  };
};

const makeInvoice = (): Invoice =>
  ({
    id: 'invoice-1',
    serviceOrderId: 'order-1',
    laborTotal: 100000,
    partsTotal: 20000,
    fixHomePartsTotal: 20000,
    technicianPartsTotal: 0,
    technicianPartWarrantyFeeTotal: 0,
    grandTotal: 120000,
    commissionBase: 'LABOR',
    commissionAmount: 10000,
    commissionRateSnapshot: 0.1,
    paymentStatus: PaymentStatus.UNPAID,
    issuedAt: new Date('2026-09-01T00:00:00.000Z'),
    paidAt: null,
    items: [],
  }) as Invoice;

const makeOrder = (): ServiceOrder =>
  ({
    id: 'order-1',
    bookingId: 'booking-1',
    status: ServiceOrderStatus.COMPLETED,
    paymentStatus: PaymentStatus.UNPAID,
  }) as ServiceOrder;

describe('FinanceService money-state invariants', () => {
  it('keeps DEMO electronic payments pending and makes retries durable by key', async () => {
    const invoice = makeInvoice();
    const order = makeOrder();
    const booking = { id: 'booking-1', customerId: 'customer-1' } as Booking;
    const firstPayment = {
      id: 'payment-1',
      invoiceId: invoice.id,
      commissionDueId: null,
      purpose: 'invoice',
      amount: invoice.grandTotal,
      currency: 'VND',
      mode: PaymentMode.DEMO,
      status: PaymentAttemptStatus.PENDING,
      idempotencyKey: 'checkout-20260915-retry-1',
      requestedByUserId: booking.customerId,
      requestedAt: new Date(),
      verifiedAt: null,
      failureCode: null,
    } as Payment;
    const setup = makeFinanceService({ invoice, order, booking });
    const paymentRepository = setup.repositories.get(Payment);
    paymentRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(firstPayment);
    paymentRepository.create = vi.fn((value) => ({ ...firstPayment, ...value }));
    paymentRepository.save = vi.fn(async (value) => value);

    const result = await setup.service.initiateInvoicePayment(
      invoice.id,
      actor(booking.customerId, Role.CUSTOMER),
      paymentDto(firstPayment.idempotencyKey),
    );
    const retry = await setup.service.initiateInvoicePayment(
      invoice.id,
      actor(booking.customerId, Role.CUSTOMER),
      paymentDto(firstPayment.idempotencyKey),
    );

    expect(result.status).toBe(PaymentAttemptStatus.PENDING);
    expect(retry.id).toBe(firstPayment.id);
    expect(invoice.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(setup.verificationPort.verify).not.toHaveBeenCalled();
  });

  it('persists a disputed cash mismatch and opens SupportCase without paying the invoice', async () => {
    const invoice = makeInvoice();
    const order = makeOrder();
    const booking = { id: 'booking-1', customerId: 'customer-1' } as Booking;
    const assignment = {
      serviceOrderId: order.id,
      technicianId: 'technician-1',
      isActive: true,
    } as TechnicianAssignment;
    const setup = makeFinanceService({ invoice, order, booking, assignment, settlement: null });
    const settlementRepository = setup.repositories.get(CashSettlement);
    const createdSettlement = {
      id: 'settlement-1',
      serviceOrderId: order.id,
      declaredByTechnicianId: assignment.technicianId,
      declaredAmount: 119000,
      declaredAt: new Date(),
      status: CashSettlementStatus.DISPUTED,
    } as CashSettlement;
    settlementRepository.create = vi.fn(() => createdSettlement);
    settlementRepository.save = vi.fn(async (value) => value);

    const declaration = Object.assign(new CashSettlementDeclarationDto(), {
      declaredAmount: 119000,
    });

    await expect(
      setup.service.declareCashSettlement(
        order.id,
        declaration,
        actor(assignment.technicianId, Role.TECHNICIAN),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.CASH_SETTLEMENT_MISMATCH }),
    });
    expect(createdSettlement.status).toBe(CashSettlementStatus.DISPUTED);
    expect(invoice.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(setup.supportCasesService.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ serviceOrderId: order.id }),
      expect.anything(),
    );
  });

  it('confirms exact cash only for the customer and snapshots 10% labor plus parts', async () => {
    const invoice = makeInvoice();
    const order = makeOrder();
    const booking = { id: 'booking-1', customerId: 'customer-1' } as Booking;
    const assignment = {
      serviceOrderId: order.id,
      technicianId: 'technician-1',
      isActive: true,
    } as TechnicianAssignment;
    const settlement = {
      id: 'settlement-1',
      serviceOrderId: order.id,
      declaredByTechnicianId: assignment.technicianId,
      declaredAmount: invoice.grandTotal,
      declaredAt: new Date(),
      status: CashSettlementStatus.PENDING_CONFIRMATION,
      confirmedByCustomerId: null,
      confirmedAmount: null,
      confirmedAt: null,
    } as CashSettlement;
    const setup = makeFinanceService({ invoice, order, booking, assignment, settlement });
    const settlementRepository = setup.repositories.get(CashSettlement);
    const paymentRepository = setup.repositories.get(Payment);
    const commissionDueRepository = setup.repositories.get(CommissionDue);
    const platformDueRepository = setup.repositories.get(PlatformDue);
    const savedPayments: Payment[] = [];
    const savedCommissionDues: CommissionDue[] = [];
    const savedPlatformDues: PlatformDue[] = [];
    settlementRepository.save = vi.fn(async (value) => value);
    paymentRepository.findOne = vi.fn().mockResolvedValue(null);
    paymentRepository.create = vi.fn((value) => ({ id: 'payment-1', ...value }));
    paymentRepository.save = vi.fn(async (value) => {
      savedPayments.push(value);
      return value;
    });
    commissionDueRepository.findOne = vi.fn().mockResolvedValue(null);
    commissionDueRepository.create = vi.fn((value) => ({ id: 'due-1', ...value }));
    commissionDueRepository.save = vi.fn(async (value) => {
      savedCommissionDues.push(value);
      return value;
    });
    platformDueRepository.findOne = vi.fn().mockResolvedValue(null);
    platformDueRepository.create = vi.fn((value) => ({ id: 'platform-due-1', ...value }));
    platformDueRepository.save = vi.fn(async (value) => {
      savedPlatformDues.push(value);
      return value;
    });

    const confirmation = Object.assign(new CashSettlementConfirmationDto(), { agreed: true });
    const result = await setup.service.confirmCashSettlement(
      order.id,
      confirmation,
      actor(booking.customerId, Role.CUSTOMER),
    );

    expect(result.status).toBe(CashSettlementStatus.CONFIRMED);
    expect(invoice.paymentStatus).toBe(PaymentStatus.PAID);
    expect(setup.serviceOrderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      { paymentStatus: PaymentStatus.PAID },
    );
    expect(savedPayments[0]).toMatchObject({
      status: PaymentAttemptStatus.VERIFIED,
      amount: 120000,
      mode: PaymentMode.DEMO,
    });
    expect(savedCommissionDues[0]).toMatchObject({
      laborTotalSnapshot: 100000,
      commissionRateSnapshot: 0.1,
      dueAmount: 10000,
    });
    expect(savedPlatformDues[0]).toMatchObject({
      commissionAmountSnapshot: 10000,
      fixHomePartsTotalSnapshot: 20000,
      dueAmount: 30000,
    });
  });

  it('rejects manager from the normal customer confirmation path', async () => {
    const setup = makeFinanceService({ invoice: makeInvoice(), order: makeOrder() });
    await expect(
      setup.service.confirmCashSettlement(
        'order-1',
        Object.assign(new CashSettlementConfirmationDto(), { agreed: true }),
        actor('manager-1', Role.SERVICE_MANAGER),
      ),
    ).rejects.toBeInstanceOf(BusinessException);
    expect(setup.serviceOrderRepository.findOne).not.toHaveBeenCalled();
  });

  it('rejects invalid amounts for wallet top-up', async () => {
    const setup = makeFinanceService({});
    await expect(
      setup.service.createWalletTopUpVnpayUrl('tech-1', 5000, '127.0.0.1'),
    ).rejects.toBeInstanceOf(BusinessException);

    await expect(
      setup.service.createWalletTopUpVnpayUrl('tech-1', 60000000, '127.0.0.1'),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('creates wallet top-up payment record and generates valid VNPay URL', async () => {
    const setup = makeFinanceService({});
    setup.nestConfigService.get.mockImplementation((key: string) => {
      if (key === 'VNPAY_TMN_CODE') return 'TEST_TMN';
      if (key === 'VNPAY_HASH_SECRET') return 'SECRET1234567890SECRET1234567890';
      if (key === 'VNPAY_PAYMENT_URL') return 'https://sandbox.vnpayment.vn/vpcpay.html';
      if (key === 'VNPAY_RETURN_URL') return 'http://localhost:3000/api/v1/finance/vnpay/return';
      return null;
    });

    const paymentSaved = {
      id: 'pay-topup-1',
      idempotencyKey: 'IDEMP_TOPUP_1',
      amount: 200000,
    };
    setup.paymentRepository.findOne = vi.fn().mockResolvedValue(null);
    setup.paymentRepository.create = vi.fn().mockImplementation((val) => val);
    setup.paymentRepository.save = vi.fn().mockResolvedValue(paymentSaved);

    const result = await setup.service.createWalletTopUpVnpayUrl(
      'tech-1',
      200000,
      '127.0.0.1',
      'IDEMP_TOPUP_1',
      'mobile',
    );

    expect(result.paymentId).toBe('pay-topup-1');
    expect(result.paymentUrl).toContain('https://sandbox.vnpayment.vn/vpcpay.html?');
    expect(result.paymentUrl).toContain('vnp_Amount=20000000');
    expect(result.paymentUrl).toContain('vnp_SecureHash=');
  });
});

describe('Dues follow the invoice formula', () => {
  const settle = async (invoiceOverrides: Partial<Invoice>, settlement: CashSettlement | null) => {
    const invoice = { ...makeInvoice(), ...invoiceOverrides } as Invoice;
    const order = makeOrder();
    const assignment = { serviceOrderId: order.id, technicianId: 'technician-1', isActive: true } as TechnicianAssignment;
    const setup = makeFinanceService({ invoice, order, booking: { id: 'booking-1', customerId: 'customer-1' } as Booking, assignment, settlement: settlement ?? undefined });
    const commissionDues: CommissionDue[] = [];
    const platformDues: PlatformDue[] = [];
    const commissionDueRepository = setup.repositories.get(CommissionDue);
    const platformDueRepository = setup.repositories.get(PlatformDue);
    commissionDueRepository.findOne = vi.fn().mockResolvedValue(null);
    commissionDueRepository.create = vi.fn((value) => value);
    commissionDueRepository.save = vi.fn(async (value) => { commissionDues.push(value); return value; });
    platformDueRepository.findOne = vi.fn().mockResolvedValue(null);
    platformDueRepository.create = vi.fn((value) => value);
    platformDueRepository.save = vi.fn(async (value) => { platformDues.push(value); return value; });
    const ensure = (setup.service as unknown as {
      ensureFinancialDues: (...args: unknown[]) => Promise<void>;
    }).ensureFinancialDues.bind(setup.service);
    await ensure(setup.manager, invoice, order, settlement, new Date('2026-10-07T00:00:00Z'));
    return { commissionDues, platformDues };
  };
  const cash = { id: 'settlement-1', declaredByTechnicianId: 'technician-1' } as CashSettlement;

  it('uses the rate frozen on the invoice, not a constant', async () => {
    const { commissionDues, platformDues } = await settle({ commissionRateSnapshot: 0.15, commissionAmount: 15000 }, cash);
    expect(commissionDues[0]).toMatchObject({ commissionRateSnapshot: 0.15, dueAmount: 15000 });
    expect(platformDues[0]).toMatchObject({ commissionRateSnapshot: 0.15, dueAmount: 35000 });
  });

  it('owes commission plus FixHome parts plus shipping, never the technician\'s own parts or warranty fee', async () => {
    const { platformDues } = await settle({
      laborTotal: 500000, commissionAmount: 50000,
      partsTotal: 300000, fixHomePartsTotal: 0, technicianPartsTotal: 300000,
      technicianPartWarrantyFeeTotal: 40000, shippingFee: 15000,
      grandTotal: 855000,
    }, cash);
    expect(platformDues[0]).toMatchObject({ fixHomePartsTotalSnapshot: 0, dueAmount: 65000 });
  });

  it('records an online payment\'s commission as collected and opens no PlatformDue', async () => {
    const { commissionDues, platformDues } = await settle({}, null);
    expect(commissionDues[0]).toMatchObject({ status: CommissionDueStatus.PAID, dueAmount: 10000 });
    expect(platformDues).toHaveLength(0);
  });
});
