import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SupportCase } from './entities/support-case.entity';
import { SupportCasesService } from './support-cases.service';
import {
  Role,
  SupportCaseStatus,
  SupportCaseType,
} from '../../shared/enums';

const CUSTOMER_ID = 'customer-1';
const TECHNICIAN_ID = 'technician-1';
const BOOKING_ID = 'booking-1';
const ORDER_ID = 'order-1';

const booking = { id: BOOKING_ID, customerId: CUSTOMER_ID };
const order = { id: ORDER_ID, bookingId: BOOKING_ID };

const makeEscalationService = (options: {
  bookingResult?: unknown;
  orderResult?: unknown;
  orderByBookingResult?: unknown;
  assignmentResult?: unknown;
} = {}) => {
  const supportRepository = {
    create: vi.fn((value: unknown) => value),
    save: vi.fn(async (value: unknown) => ({
      ...(value as Record<string, unknown>),
      id: 'case-1',
    })),
  };
  const bookingRepository = {
    findOne: vi.fn(async ({ where }: { where: { id: string } }) => {
      if (where.id === BOOKING_ID) return options.bookingResult ?? booking;
      if (where.id === 'booking-2')
        return (
          options.bookingResult ?? { id: 'booking-2', customerId: CUSTOMER_ID }
        );
      return null;
    }),
    save: vi.fn(),
    update: vi.fn(),
  };
  const serviceOrderRepository = {
    findOne: vi.fn(async ({ where }: { where: Record<string, string> }) => {
      if (where.id === ORDER_ID)
        return 'orderResult' in options ? options.orderResult : order;
      if (where.bookingId === BOOKING_ID)
        return 'orderByBookingResult' in options
          ? options.orderByBookingResult
          : order;
      return null;
    }),
    save: vi.fn(),
    update: vi.fn(),
  };
  const invoiceRepository = { findOne: vi.fn(), save: vi.fn(), update: vi.fn() };
  const cashSettlementRepository = {
    findOne: vi.fn(),
    save: vi.fn(),
    update: vi.fn(),
  };
  const assignmentRepository = {
    findOne: vi.fn().mockResolvedValue(options.assignmentResult ?? null),
  };

  const service = new SupportCasesService(
    supportRepository as any,
    bookingRepository as any,
    serviceOrderRepository as any,
    invoiceRepository as any,
    cashSettlementRepository as any,
    assignmentRepository as any,
    { logWithManagerStrict: vi.fn() } as any,
  );

  return {
    service,
    supportRepository,
    bookingRepository,
    serviceOrderRepository,
    invoiceRepository,
    cashSettlementRepository,
    assignmentRepository,
  };
};

const customerDto = (overrides = {}) =>
  ({
    caseType: SupportCaseType.CASH_MISMATCH,
    reason: 'The declared cash amount does not match my invoice',
    serviceOrderId: ORDER_ID,
    ...overrides,
  }) as any;

describe('SupportCasesService.openCaseForActor', () => {
  it('lets a customer open a case for their own order with derived ids and OPEN status', async () => {
    const { service, supportRepository, serviceOrderRepository } =
      makeEscalationService({
        assignmentResult: { technicianId: TECHNICIAN_ID },
      });

    const result = (await service.openCaseForActor(
      customerDto({ bookingId: BOOKING_ID }),
      { id: CUSTOMER_ID, role: Role.CUSTOMER },
    )) as SupportCase;

    expect(result.status).toBe(SupportCaseStatus.OPEN);
    expect(result).toMatchObject({
      customerId: CUSTOMER_ID,
      technicianId: TECHNICIAN_ID,
      createdByUserId: CUSTOMER_ID,
      assignedManagerId: null,
      bookingId: BOOKING_ID,
      serviceOrderId: ORDER_ID,
    });
    expect(supportRepository.save).toHaveBeenCalledTimes(1);
    expect(serviceOrderRepository.save).not.toHaveBeenCalled();
    expect(serviceOrderRepository.update).not.toHaveBeenCalled();
  });

  it('rejects a customer opening a case for a foreign booking', async () => {
    const { service, supportRepository } = makeEscalationService({
      bookingResult: { id: BOOKING_ID, customerId: 'customer-2' },
    });

    await expect(
      service.openCaseForActor(customerDto(), {
        id: CUSTOMER_ID,
        role: Role.CUSTOMER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(supportRepository.save).not.toHaveBeenCalled();
  });

  it('lets an assigned technician open a case and derives authoritative ids', async () => {
    const { service } = makeEscalationService({
      assignmentResult: { technicianId: TECHNICIAN_ID },
    });

    const result = (await service.openCaseForActor(
      {
        caseType: SupportCaseType.PARTS_DISPUTE,
        reason: 'Parts supplied for this order are disputed by the customer',
        serviceOrderId: ORDER_ID,
      } as any,
      { id: TECHNICIAN_ID, role: Role.TECHNICIAN },
    )) as SupportCase;

    expect(result.status).toBe(SupportCaseStatus.OPEN);
    expect(result).toMatchObject({
      customerId: CUSTOMER_ID,
      technicianId: TECHNICIAN_ID,
      createdByUserId: TECHNICIAN_ID,
      serviceOrderId: ORDER_ID,
    });
  });

  it('lets a technician escalate from a booking-only context they are assigned to', async () => {
    const { service } = makeEscalationService({
      assignmentResult: { technicianId: TECHNICIAN_ID },
    });

    const result = (await service.openCaseForActor(
      {
        caseType: SupportCaseType.ARRIVAL_ABNORMAL,
        reason: 'Access to the site was blocked on arrival',
        bookingId: BOOKING_ID,
      } as any,
      { id: TECHNICIAN_ID, role: Role.TECHNICIAN },
    )) as SupportCase;

    expect(result).toMatchObject({
      bookingId: BOOKING_ID,
      technicianId: TECHNICIAN_ID,
      createdByUserId: TECHNICIAN_ID,
    });
  });

  it('rejects a technician opening a case for an unrelated order', async () => {
    const { service, supportRepository } = makeEscalationService({
      assignmentResult: null,
    });

    await expect(
      service.openCaseForActor(customerDto(), {
        id: 'technician-2',
        role: Role.TECHNICIAN,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(supportRepository.save).not.toHaveBeenCalled();
  });

  it('rejects mismatched booking/order contexts and free-floating cases', async () => {
    const { service } = makeEscalationService({});
    await expect(
      service.openCaseForActor(
        customerDto({ bookingId: 'booking-2' }),
        { id: CUSTOMER_ID, role: Role.CUSTOMER },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.openCaseForActor(
        {
          caseType: SupportCaseType.OTHER,
          reason: 'A context-free escalation attempt',
        } as any,
        { id: CUSTOMER_ID, role: Role.CUSTOMER },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps missing references to 404 and blocks manager actors with 403', async () => {
    const { service } = makeEscalationService({
      orderResult: null,
      orderByBookingResult: null,
    });

    await expect(
      service.openCaseForActor(customerDto(), {
        id: CUSTOMER_ID,
        role: Role.CUSTOMER,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      service.openCaseForActor(customerDto({ bookingId: BOOKING_ID }), {
        id: 'manager-1',
        role: Role.SERVICE_MANAGER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never mutates booking, order, invoice, or settlement repositories', async () => {
    const setup = makeEscalationService({
      assignmentResult: { technicianId: TECHNICIAN_ID },
    });

    await setup.service.openCaseForActor(customerDto({ bookingId: BOOKING_ID }), {
      id: CUSTOMER_ID,
      role: Role.CUSTOMER,
    });

    for (const repository of [
      setup.bookingRepository,
      setup.serviceOrderRepository,
      setup.invoiceRepository,
      setup.cashSettlementRepository,
    ]) {
      expect(repository.save).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    }
  });
});
