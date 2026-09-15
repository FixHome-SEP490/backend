import { describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { SupportCasesService } from './support-cases.service';
import { SupportCase } from './entities/support-case.entity';
import { QuerySupportCasesDto } from './dto';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Payment } from '../finance/entities/payment.entity';
import { PlatformDue } from '../finance/entities/platform-due.entity';
import { CASH_SETTLEMENT_MANAGER_CONFIRMATION_CODE } from '../../shared/constants';
import {
  CashSettlementStatus,
  CommissionDueStatus,
  PaymentAttemptStatus,
  PaymentMode,
  PaymentPurpose,
  PaymentStatus,
  PlatformDueStatus,
  SupportCaseStatus,
  SupportCaseType,
} from '../../shared/enums';

const makeCase = (overrides: Partial<SupportCase> = {}): SupportCase =>
  ({
    id: 'case-1',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    caseType: SupportCaseType.CASH_MISMATCH,
    status: SupportCaseStatus.OPEN,
    bookingId: null,
    serviceOrderId: null,
    customerId: null,
    technicianId: null,
    createdByUserId: null,
    assignedManagerId: null,
    reason: 'A customer reported a cash amount mismatch',
    description: null,
    resolutionCode: null,
    resolutionReason: null,
    evidenceRefs: null,
    resolvedAt: null,
    ...overrides,
  }) as SupportCase;

const makeService = (
  supportCase = makeCase(),
  transactionRepositories?: Map<unknown, any>,
) => {
  const transactionSupportRepository = {
    findOne: vi.fn().mockResolvedValue(supportCase),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
    findOneByOrFail: vi.fn().mockResolvedValue(supportCase),
  };
  const transactionManager = {
    getRepository: vi.fn(
      (entity: unknown) =>
        transactionRepositories?.get(entity) ?? transactionSupportRepository,
    ),
  };
  const supportRepository = {
    create: vi.fn((value) => value),
    save: vi.fn(async (value) => value),
    findOneBy: vi.fn().mockResolvedValue(supportCase),
    createQueryBuilder: vi.fn(),
    manager: {
      transaction: vi.fn(async (callback) => callback(transactionManager)),
    },
  };
  const bookingRepository = {
    findOne: vi.fn(),
    save: vi.fn(),
    update: vi.fn(),
  };
  const serviceOrderRepository = {
    findOne: vi.fn(),
    save: vi.fn(),
    update: vi.fn(),
  };
  const invoiceRepository = {
    findOne: vi.fn(),
    save: vi.fn(),
    update: vi.fn(),
  };
  const cashSettlementRepository = {
    findOne: vi.fn(),
    save: vi.fn(),
    update: vi.fn(),
  };
  const auditLogService = {
    logWithManagerStrict: vi.fn().mockResolvedValue(undefined),
  };

  return {
    service: new SupportCasesService(
      supportRepository as any,
      bookingRepository as any,
      serviceOrderRepository as any,
      invoiceRepository as any,
      cashSettlementRepository as any,
      auditLogService as any,
    ),
    supportRepository,
    transactionSupportRepository,
    auditLogService,
    bookingRepository,
    serviceOrderRepository,
    invoiceRepository,
    cashSettlementRepository,
  };
};

describe('SupportCasesService', () => {
  it('opens a bounded internal case without exposing a public creation flow', async () => {
    const { service, supportRepository } = makeService();

    const result = await service.openCase({
      caseType: SupportCaseType.MATCHING_EXHAUSTED,
      reason: 'No suitable technician accepted the booking',
      description: 'The matching queue exhausted all candidates.',
      bookingId: 'booking-1',
      evidenceRefs: ['storage://support/case-1/photo-1'],
    });

    expect(supportRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        caseType: SupportCaseType.MATCHING_EXHAUSTED,
        status: SupportCaseStatus.OPEN,
        bookingId: 'booking-1',
        reason: 'No suitable technician accepted the booking',
        evidenceRefs: ['storage://support/case-1/photo-1'],
      }),
    );
    expect(supportRepository.save).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(SupportCaseStatus.OPEN);
  });

  it('applies typed queue filters and bounded pagination without loading source context', async () => {
    const { service, supportRepository } = makeService();
    const queryBuilder = {
      andWhere: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      take: vi.fn().mockReturnThis(),
      getManyAndCount: vi.fn().mockResolvedValue([[makeCase()], 1]),
    };
    supportRepository.createQueryBuilder.mockReturnValue(queryBuilder);

    const query = Object.assign(new QuerySupportCasesDto(), {
      page: 2,
      limit: 50,
      caseType: SupportCaseType.CASH_MISMATCH,
      status: SupportCaseStatus.OPEN,
      bookingId: 'booking-1',
      serviceOrderId: 'order-1',
      assignedManagerId: 'manager-1',
      search: 'cash',
    });
    const result = await service.findAll(query);

    expect(result.total).toBe(1);
    expect(queryBuilder.andWhere).toHaveBeenCalledTimes(6);
    expect(queryBuilder.skip).toHaveBeenCalledWith(50);
    expect(queryBuilder.take).toHaveBeenCalledWith(50);
    expect(result.data[0]).not.toHaveProperty('booking');
  });

  it('resolves only OPEN or IN_REVIEW cases and assigns an unassigned resolver', async () => {
    const supportCase = makeCase({ status: SupportCaseStatus.IN_REVIEW });
    const { service, transactionSupportRepository, auditLogService } =
      makeService(supportCase);

    const result = await service.resolveCase(
      supportCase.id,
      {
        finalStatus: SupportCaseStatus.RESOLVED,
        resolutionCode: 'CUSTOMER_CONFIRMED',
        reason: 'The customer confirmed the amount after manager review.',
        evidenceRefs: ['storage://support/case-1/confirmation'],
      },
      { id: 'manager-1', role: 'service_manager' },
    );

    expect(transactionSupportRepository.update).toHaveBeenCalledWith(
      { id: supportCase.id, status: expect.anything() },
      expect.objectContaining({
        status: SupportCaseStatus.RESOLVED,
        assignedManagerId: 'manager-1',
        resolutionCode: 'CUSTOMER_CONFIRMED',
        resolutionReason:
          'The customer confirmed the amount after manager review.',
        evidenceRefs: ['storage://support/case-1/confirmation'],
        resolvedAt: expect.any(Date),
      }),
    );
    expect(auditLogService.logWithManagerStrict).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceType: 'support_case',
        resourceId: supportCase.id,
        action: 'SUPPORT_CASE_RESOLVE',
        before: { status: SupportCaseStatus.IN_REVIEW },
        after: expect.objectContaining({
          status: SupportCaseStatus.RESOLVED,
          finalStatus: SupportCaseStatus.RESOLVED,
          resolutionCode: 'CUSTOMER_CONFIRMED',
          reason: 'The customer confirmed the amount after manager review.',
        }),
      }),
    );
    expect(result.id).toBe(supportCase.id);
  });

  it('rejects terminal cases with 409 and does not update or audit them', async () => {
    const supportCase = makeCase({ status: SupportCaseStatus.RESOLVED });
    const { service, transactionSupportRepository, auditLogService } =
      makeService(supportCase);

    await expect(
      service.resolveCase(
        supportCase.id,
        {
          finalStatus: SupportCaseStatus.REJECTED,
          resolutionCode: 'DUPLICATE',
          reason: 'The support request duplicated an already resolved case.',
        },
        { id: 'manager-1', role: 'service_manager' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(transactionSupportRepository.update).not.toHaveBeenCalled();
    expect(auditLogService.logWithManagerStrict).not.toHaveBeenCalled();
  });

  it('requires a service manager at the service boundary', async () => {
    const { service, supportRepository } = makeService();

    await expect(
      service.resolveCase(
        'case-1',
        {
          finalStatus: SupportCaseStatus.RESOLVED,
          resolutionCode: 'NOT_ALLOWED',
          reason: 'This actor must not resolve support cases.',
        },
        { id: 'admin-1', role: 'admin' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(supportRepository.manager.transaction).not.toHaveBeenCalled();
  });

  it('rolls back the resolution when strict audit fails', async () => {
    const supportCase = makeCase();
    const {
      service,
      transactionSupportRepository,
      auditLogService,
      supportRepository,
    } = makeService(supportCase);
    auditLogService.logWithManagerStrict.mockRejectedValueOnce(
      new Error('audit unavailable'),
    );

    await expect(
      service.resolveCase(
        supportCase.id,
        {
          finalStatus: SupportCaseStatus.REJECTED,
          resolutionCode: 'NOT_SUPPORTED',
          reason:
            'The reported issue could not be substantiated by the evidence.',
        },
        { id: 'manager-1', role: 'service_manager' },
      ),
    ).rejects.toThrow('audit unavailable');

    expect(transactionSupportRepository.update).toHaveBeenCalledTimes(1);
    expect(supportRepository.findOneBy).not.toHaveBeenCalled();
  });

  it('projects current canonical context and never writes to source repositories', async () => {
    const supportCase = makeCase({
      bookingId: 'booking-1',
      serviceOrderId: 'order-1',
      customerId: 'customer-1',
      technicianId: 'technician-1',
    });
    const {
      service,
      bookingRepository,
      serviceOrderRepository,
      invoiceRepository,
      cashSettlementRepository,
    } = makeService(supportCase);
    bookingRepository.findOne.mockResolvedValue({
      id: 'booking-1',
      status: 'matched',
      customerId: 'customer-1',
      serviceId: 'service-1',
    });
    serviceOrderRepository.findOne.mockResolvedValue({
      id: 'order-1',
      code: 'SO-1',
      status: 'completed',
      paymentStatus: 'paid',
      laborTotal: '100000',
      partsTotal: 25000,
      grandTotal: '125000',
    });
    invoiceRepository.findOne.mockResolvedValue({
      id: 'invoice-1',
      laborTotal: '100000',
      partsTotal: '25000',
      grandTotal: '125000',
      paymentStatus: 'paid',
      issuedAt: new Date('2026-09-01T01:00:00.000Z'),
      paidAt: new Date('2026-09-01T02:00:00.000Z'),
    });
    cashSettlementRepository.findOne.mockResolvedValue({
      id: 'cash-1',
      status: 'confirmed',
      declaredAmount: '125000.00',
      confirmedAmount: '125000.00',
      declaredAt: new Date('2026-09-01T03:00:00.000Z'),
      confirmedAt: new Date('2026-09-01T04:00:00.000Z'),
      technicianNotes: 'Received in person',
      receiptEvidenceUrl: 'storage://receipts/cash-1',
    });

    const result = await service.findById(supportCase.id);

    expect(result.booking).toEqual({
      id: 'booking-1',
      status: 'matched',
      customerId: 'customer-1',
      serviceId: 'service-1',
    });
    expect(result.serviceOrder).toMatchObject({
      id: 'order-1',
      laborTotal: 100000,
      partsTotal: 25000,
      grandTotal: 125000,
    });
    expect(result.invoice).toMatchObject({
      id: 'invoice-1',
      grandTotal: 125000,
    });
    expect(result.cashSettlement).toMatchObject({
      id: 'cash-1',
      declaredAmount: 125000,
      confirmedAmount: 125000,
    });
    expect(bookingRepository.save).not.toHaveBeenCalled();
    expect(bookingRepository.update).not.toHaveBeenCalled();
    expect(serviceOrderRepository.save).not.toHaveBeenCalled();
    expect(serviceOrderRepository.update).not.toHaveBeenCalled();
    expect(invoiceRepository.save).not.toHaveBeenCalled();
    expect(invoiceRepository.update).not.toHaveBeenCalled();
    expect(cashSettlementRepository.save).not.toHaveBeenCalled();
    expect(cashSettlementRepository.update).not.toHaveBeenCalled();
  });

  it('uses the SupportCase authority for audited manager cash resolution', async () => {
    const supportCase = makeCase({
      caseType: SupportCaseType.CASH_MISMATCH,
      bookingId: 'booking-1',
      serviceOrderId: 'order-1',
      customerId: 'customer-1',
      technicianId: 'technician-1',
    });
    const settlement = {
      id: 'cash-1',
      serviceOrderId: 'order-1',
      declaredByTechnicianId: 'technician-1',
      declaredAmount: 119000,
      declaredAt: new Date('2026-09-01T03:00:00.000Z'),
      status: CashSettlementStatus.DISPUTED,
      confirmedByCustomerId: 'customer-1',
    } as CashSettlement;
    const invoice = {
      id: 'invoice-1',
      serviceOrderId: 'order-1',
      laborTotal: 100000,
      partsTotal: 20000,
      grandTotal: 120000,
      commissionAmount: 10000,
      paymentStatus: PaymentStatus.UNPAID,
    } as Invoice;
    const settlementRepository = {
      findOne: vi.fn().mockResolvedValue(settlement),
      save: vi.fn(async (value) => value),
    };
    const invoiceRepository = {
      findOne: vi.fn().mockResolvedValue(invoice),
      save: vi.fn(async (value) => value),
    };
    const orderRepository = { update: vi.fn().mockResolvedValue(undefined) };
    const paymentRepository = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn((value) => ({ id: 'payment-1', ...value })),
      save: vi.fn(async (value) => value),
    };
    const commissionDueRepository = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn((value) => ({ id: 'due-1', ...value })),
      save: vi.fn(async (value) => value),
    };
    const platformDueRepository = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn((value) => ({ id: 'platform-1', ...value })),
      save: vi.fn(async (value) => value),
    };
    const transactionRepositories = new Map<unknown, any>([
        [CashSettlement, settlementRepository],
        [Invoice, invoiceRepository],
        [ServiceOrder, orderRepository],
        [Payment, paymentRepository],
        [CommissionDue, commissionDueRepository],
        [PlatformDue, platformDueRepository],
      ]);
    const { service, auditLogService } = makeService(
      supportCase,
      transactionRepositories,
    );

    await service.resolveCase(
      supportCase.id,
      {
        finalStatus: SupportCaseStatus.RESOLVED,
        resolutionCode: CASH_SETTLEMENT_MANAGER_CONFIRMATION_CODE,
        reason: 'Manager reviewed the evidence and confirmed the cash exception.',
      },
      { id: 'manager-1', role: 'service_manager' },
    );

    expect(settlement.status).toBe(CashSettlementStatus.CONFIRMED);
    expect(settlement.confirmedByCustomerId).toBeNull();
    expect(settlement.resolvedByManagerId).toBe('manager-1');
    expect(invoice.paymentStatus).toBe(PaymentStatus.PAID);
    expect(paymentRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: PaymentPurpose.INVOICE,
        mode: PaymentMode.DEMO,
        status: PaymentAttemptStatus.VERIFIED,
      }),
    );
    expect(commissionDueRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: CommissionDueStatus.PENDING,
        commissionRateSnapshot: 0.1,
        dueAmount: 10000,
      }),
    );
    expect(platformDueRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PlatformDueStatus.PENDING,
        dueAmount: 30000,
      }),
    );
    expect(auditLogService.logWithManagerStrict).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'SUPPORT_CASE_RESOLVE',
        resourceId: supportCase.id,
      }),
    );
  });
});
