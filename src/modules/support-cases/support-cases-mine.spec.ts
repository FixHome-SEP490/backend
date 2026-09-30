import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { Role, SupportCaseStatus, SupportCaseType } from '../../shared/enums';
import { QueryMySupportCasesDto } from './dto';
import { SupportCase } from './entities/support-case.entity';
import {
  allowedCaseTypes,
  isCompletionWindowOpen,
  respondByFor,
} from './support-case-policy';
import { SupportCasesController } from './support-cases.controller';
import { SupportCasesService } from './support-cases.service';
import { ServiceOrderStatus } from '../../shared/enums';

const CUSTOMER_ID = 'customer-1';
const TECHNICIAN_ID = 'technician-1';

const makeCase = (overrides: Partial<SupportCase> = {}): SupportCase =>
  ({
    id: 'case-1',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    caseType: SupportCaseType.QUALITY,
    status: SupportCaseStatus.OPEN,
    bookingId: 'booking-1',
    serviceOrderId: 'order-1',
    customerId: CUSTOMER_ID,
    technicianId: TECHNICIAN_ID,
    createdByUserId: CUSTOMER_ID,
    assignedManagerId: 'manager-secret',
    reason: 'The repair did not fix the leak',
    description: null,
    resolutionCode: 'INTERNAL_CODE',
    resolutionReason: null,
    evidenceRefs: null,
    resolvedAt: null,
    isUrgent: false,
    respondBy: null,
    ...overrides,
  }) as SupportCase;

const makeService = (supportCase = makeCase()) => {
  const queryBuilder = {
    where: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    take: vi.fn().mockReturnThis(),
    getManyAndCount: vi.fn().mockResolvedValue([[supportCase], 1]),
  };
  const supportRepository = {
    createQueryBuilder: vi.fn(() => queryBuilder),
    findOneBy: vi.fn().mockResolvedValue(supportCase),
  };
  const service = new SupportCasesService(
    supportRepository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { service, supportRepository, queryBuilder };
};

describe('SupportCasesService own-case reads', () => {
  it('filters a customer by customerId and a technician by technicianId', async () => {
    const customer = makeService();
    await customer.service.findMine(
      { id: CUSTOMER_ID, role: Role.CUSTOMER },
      Object.assign(new QueryMySupportCasesDto(), {
        status: SupportCaseStatus.OPEN,
        serviceOrderId: 'order-1',
      }),
    );
    expect(customer.queryBuilder.where).toHaveBeenCalledWith(
      'supportCase.customerId = :actorId',
      { actorId: CUSTOMER_ID },
    );
    expect(customer.queryBuilder.andWhere).toHaveBeenCalledTimes(2);

    const technician = makeService();
    await technician.service.findMine(
      { id: TECHNICIAN_ID, role: Role.TECHNICIAN },
      new QueryMySupportCasesDto(),
    );
    expect(technician.queryBuilder.where).toHaveBeenCalledWith(
      'supportCase.technicianId = :actorId',
      { actorId: TECHNICIAN_ID },
    );
  });

  it('returns an actor-safe view without manager, creator or internal code', async () => {
    const { service } = makeService();
    const result = await service.findMine(
      { id: CUSTOMER_ID, role: Role.CUSTOMER },
      new QueryMySupportCasesDto(),
    );

    expect(result.total).toBe(1);
    expect(result.data[0]).not.toHaveProperty('assignedManagerId');
    expect(result.data[0]).not.toHaveProperty('createdByUserId');
    expect(result.data[0]).not.toHaveProperty('resolutionCode');
    expect(result.data[0]).toMatchObject({ id: 'case-1', isUrgent: false });
  });

  it('answers 404 for a case that belongs to someone else or does not exist', async () => {
    const { service, supportRepository } = makeService();

    await expect(
      service.findMineById('case-1', { id: 'customer-2', role: Role.CUSTOMER }),
    ).rejects.toBeInstanceOf(NotFoundException);

    supportRepository.findOneBy.mockResolvedValueOnce(null);
    await expect(
      service.findMineById('missing', { id: CUSTOMER_ID, role: Role.CUSTOMER }),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      service.findMineById('case-1', { id: CUSTOMER_ID, role: Role.CUSTOMER }),
    ).resolves.toMatchObject({ id: 'case-1' });
  });

  it('hides the text of a complaint written by the other party but keeps its status and outcome', async () => {
    const written = makeCase({
      createdByUserId: CUSTOMER_ID,
      description: 'Kỹ thuật viên cư xử không đúng mực',
      evidenceRefs: ['https://cdn.test/a.jpg'],
      resolutionReason: 'Đã nhắc nhở kỹ thuật viên.',
      status: SupportCaseStatus.RESOLVED,
    });
    const { service } = makeService(written);

    const own = await service.findMine({ id: CUSTOMER_ID, role: Role.CUSTOMER }, new QueryMySupportCasesDto());
    expect(own.data[0].reason).toBe('The repair did not fix the leak');
    expect(own.data[0].evidenceRefs).toEqual(['https://cdn.test/a.jpg']);

    const other = await service.findMine({ id: TECHNICIAN_ID, role: Role.TECHNICIAN }, new QueryMySupportCasesDto());
    expect(other.data[0].reason).not.toContain('leak');
    expect(other.data[0].description).toBeNull();
    expect(other.data[0].evidenceRefs).toBeNull();
    expect(other.data[0]).toMatchObject({
      status: SupportCaseStatus.RESOLVED,
      resolutionReason: 'Đã nhắc nhở kỹ thuật viên.',
    });

    const detail = await service.findMineById('case-1', { id: TECHNICIAN_ID, role: Role.TECHNICIAN });
    expect(detail.description).toBeNull();
  });

  it('keeps the text of system-opened cases visible to the involved parties', async () => {
    const { service } = makeService(makeCase({ createdByUserId: null, description: 'Số tiền khai báo lệch 50.000 ₫' }));
    const result = await service.findMine({ id: TECHNICIAN_ID, role: Role.TECHNICIAN }, new QueryMySupportCasesDto());
    expect(result.data[0].description).toBe('Số tiền khai báo lệch 50.000 ₫');
  });

  it('rejects managers on the own-case read path', async () => {
    const { service } = makeService();
    await expect(
      service.findMine(
        { id: 'manager-1', role: Role.SERVICE_MANAGER },
        new QueryMySupportCasesDto(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('support case route metadata for own-case reads', () => {
  it('allows only customer/technician on mine routes with the order permission', () => {
    for (const handler of [
      SupportCasesController.prototype.findMine,
      SupportCasesController.prototype.findMineOne,
    ]) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
        Role.CUSTOMER,
        Role.TECHNICIAN,
      ]);
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toEqual([
        'order:read_related',
      ]);
    }
  });
});

describe('support case policy', () => {
  const S = SupportCaseType;

  it('lists complaint types per order phase and never system-only types', () => {
    const during = allowedCaseTypes({
      role: Role.CUSTOMER,
      orderStatus: ServiceOrderStatus.UNDER_REPAIR,
    });
    expect(during).toEqual(
      expect.arrayContaining([S.PRICING_DISPUTE, S.PROPERTY_DAMAGE, S.CONDUCT]),
    );
    expect(during).not.toContain(S.WARRANTY_DISPUTE);
    expect(during).not.toContain(S.CASH_NON_RESPONSE);

    expect(
      allowedCaseTypes({ role: Role.CUSTOMER, orderStatus: null }),
    ).toEqual([S.MATCHING_EXHAUSTED, S.OTHER]);
    expect(
      allowedCaseTypes({ role: Role.TECHNICIAN, orderStatus: null }),
    ).toEqual([]);
    expect(
      allowedCaseTypes({
        role: Role.CUSTOMER,
        orderStatus: ServiceOrderStatus.CANCELLED,
      }),
    ).toEqual([S.CANCELLATION_REVIEW, S.OTHER]);
  });

  it('keeps the completion window open for 7 days only', () => {
    const now = new Date('2026-09-30T00:00:00.000Z');
    expect(isCompletionWindowOpen(new Date('2026-09-23T00:00:00.000Z'), now)).toBe(true);
    expect(isCompletionWindowOpen(new Date('2026-09-22T23:59:59.000Z'), now)).toBe(false);
    expect(isCompletionWindowOpen(null, now)).toBe(true);
  });

  it('sets the 30 minute deadline only for active orders or urgent requests', () => {
    const now = new Date('2026-09-30T00:00:00.000Z');
    expect(respondByFor(ServiceOrderStatus.UNDER_REPAIR, false, now)).toEqual(
      new Date('2026-09-30T00:30:00.000Z'),
    );
    expect(respondByFor(ServiceOrderStatus.COMPLETED, true, now)).toEqual(
      new Date('2026-09-30T00:30:00.000Z'),
    );
    expect(respondByFor(ServiceOrderStatus.COMPLETED, false, now)).toBeNull();
  });
});
