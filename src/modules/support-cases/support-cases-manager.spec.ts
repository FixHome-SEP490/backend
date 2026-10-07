import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { Role, ServiceOrderStatus, SupportCaseStatus, SupportCaseType } from '../../shared/enums';
import { isCompletionHeld } from './completion-hold';
import { QuerySupportCasesDto, ResolveSupportCaseDto } from './dto';
import { SupportCase } from './entities/support-case.entity';
import { SupportCasesController } from './support-cases.controller';
import { SupportCasesService } from './support-cases.service';

const SM = { id: 'sm-1', role: Role.SERVICE_MANAGER };

const makeCase = (overrides: Partial<SupportCase> = {}): SupportCase =>
  ({
    id: 'case-1',
    createdAt: new Date('2026-09-29T00:00:00.000Z'),
    updatedAt: new Date('2026-09-29T00:00:00.000Z'),
    caseType: SupportCaseType.QUALITY,
    status: SupportCaseStatus.OPEN,
    bookingId: 'booking-1',
    serviceOrderId: 'order-1',
    customerId: 'customer-1',
    technicianId: 'tech-1',
    createdByUserId: 'customer-1',
    assignedManagerId: null,
    reason: 'Thợ làm hỏng gạch ốp tường',
    description: null,
    resolutionCode: null,
    resolutionReason: null,
    evidenceRefs: null,
    resolvedAt: null,
    isUrgent: false,
    respondBy: null,
    holdCompletion: false,
    liableParty: null,
    amount: null,
    ...overrides,
  }) as SupportCase;

const makeService = (supportCase = makeCase(), withNotifications = true) => {
  const txRepo = {
    findOne: vi.fn().mockResolvedValue(supportCase),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
    findOneByOrFail: vi.fn().mockResolvedValue(supportCase),
  };
  const queryBuilder = {
    andWhere: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    addOrderBy: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    take: vi.fn().mockReturnThis(),
    getManyAndCount: vi.fn().mockResolvedValue([[supportCase], 1]),
  };
  const supportRepository = {
    create: vi.fn((v) => v),
    save: vi.fn(async (v) => ({ ...v, id: 'case-new' })),
    count: vi.fn().mockResolvedValue(0),
    findOneBy: vi.fn().mockResolvedValue(supportCase),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: vi.fn(() => queryBuilder),
    manager: {
      find: vi.fn().mockResolvedValue([{ id: 'sm-1' }, { id: 'sm-2' }]),
      transaction: vi.fn(async (cb: any) => cb({ getRepository: () => txRepo })),
    },
  };
  const bookingRepository = { findOne: vi.fn().mockResolvedValue({ id: 'booking-1', customerId: 'customer-1' }) };
  const orderRepository = {
    findOne: vi.fn().mockResolvedValue({
      id: 'order-1',
      bookingId: 'booking-1',
      status: ServiceOrderStatus.UNDER_REPAIR,
      completedAt: null,
    }),
  };
  const assignmentRepository = { findOne: vi.fn().mockResolvedValue({ technicianId: 'tech-1' }) };
  const auditLogService = { log: vi.fn().mockResolvedValue(undefined), logWithManagerStrict: vi.fn().mockResolvedValue(undefined) };
  const notifications = { createManyNotifications: vi.fn().mockResolvedValue([]) };
  const service = new SupportCasesService(
    supportRepository as any,
    bookingRepository as any,
    orderRepository as any,
    { findOne: vi.fn() } as any,
    { findOne: vi.fn() } as any,
    assignmentRepository as any,
    auditLogService as any,
    { get: vi.fn() } as any,
    (withNotifications ? notifications : undefined) as any,
  );
  return { service, supportRepository, txRepo, queryBuilder, auditLogService, notifications };
};

describe('manager takes and holds a case', () => {
  it('moves OPEN to IN_REVIEW for the calling manager and audits it', async () => {
    const { service, supportRepository, auditLogService } = makeService();

    await service.startReview('case-1', SM);

    expect(supportRepository.update).toHaveBeenCalledWith(
      { id: 'case-1', status: SupportCaseStatus.OPEN },
      { status: SupportCaseStatus.IN_REVIEW, assignedManagerId: 'sm-1' },
    );
    expect(auditLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'SUPPORT_CASE_REVIEW_STARTED' }));
  });

  it('answers 409 when someone already took it, 404 when missing, 403 for non managers', async () => {
    const taken = makeService();
    taken.supportRepository.update.mockResolvedValueOnce({ affected: 0 });
    await expect(taken.service.startReview('case-1', SM)).rejects.toBeInstanceOf(ConflictException);

    const missing = makeService();
    missing.supportRepository.update.mockResolvedValueOnce({ affected: 0 });
    missing.supportRepository.findOneBy.mockResolvedValueOnce(null);
    await expect(missing.service.startReview('nope', SM)).rejects.toBeInstanceOf(NotFoundException);

    await expect(makeService().service.startReview('case-1', { id: 'a', role: Role.ADMIN })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('holds and releases completion only for an unresolved case linked to an order', async () => {
    const ok = makeService();
    await ok.service.setHold('case-1', true, SM);
    expect(ok.supportRepository.update).toHaveBeenCalledWith({ id: 'case-1' }, { holdCompletion: true });
    expect(ok.auditLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'SUPPORT_CASE_HOLD_COMPLETION' }));

    await ok.service.setHold('case-1', false, SM);
    expect(ok.auditLogService.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'SUPPORT_CASE_RELEASE_COMPLETION' }));

    const noOrder = makeService(makeCase({ serviceOrderId: null }));
    await expect(noOrder.service.setHold('case-1', true, SM)).rejects.toBeInstanceOf(BadRequestException);

    const closed = makeService(makeCase({ status: SupportCaseStatus.RESOLVED }));
    await expect(closed.service.setHold('case-1', true, SM)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('resolving a case', () => {
  const resolveInput = (overrides = {}) => ({
    finalStatus: SupportCaseStatus.RESOLVED,
    resolutionCode: 'warning_issued',
    reason: 'Đã nhắc nhở kỹ thuật viên và ghi nhận vào hồ sơ.',
    ...overrides,
  });

  it('accepts a standard outcome, records liable party and amount, releases the hold and notifies both parties', async () => {
    const { service, txRepo, notifications } = makeService(makeCase({ holdCompletion: true, status: SupportCaseStatus.IN_REVIEW }));

    await service.resolveCase('case-1', resolveInput({ liableParty: 'technician', amount: 150000 }) as any, SM);

    expect(txRepo.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ holdCompletion: false, liableParty: 'technician', amount: 150000, resolutionCode: 'warning_issued' }),
    );
    expect(notifications.createManyNotifications).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'customer-1', type: 'SUPPORT_CASE_RESOLVED' }),
      expect.objectContaining({ userId: 'tech-1', type: 'SUPPORT_CASE_RESOLVED' }),
    ]);
  });

  it('rejects a free-text outcome for a non-cash case but keeps cash cases on their own codes', async () => {
    const complaint = makeService();
    await expect(complaint.service.resolveCase('case-1', resolveInput({ resolutionCode: 'CUSTOMER_CONFIRMED' }) as any, SM)).rejects.toBeInstanceOf(BadRequestException);
    expect(complaint.txRepo.update).not.toHaveBeenCalled();

    const cash = makeService(makeCase({ caseType: SupportCaseType.CASH_MISMATCH }));
    await expect(cash.service.resolveCase('case-1', resolveInput({ resolutionCode: 'CUSTOMER_CONFIRMED' }) as any, SM)).resolves.toBeDefined();
  });

  it('validates the extra resolve fields', async () => {
    const errors = await validate(
      Object.assign(new ResolveSupportCaseDto(), {
        finalStatus: SupportCaseStatus.RESOLVED,
        resolutionCode: 'no_action',
        reason: 'Đã xem xét đầy đủ bằng chứng.',
        liableParty: 'nobody',
        amount: -5,
      }),
    );
    expect(errors.map((e) => e.property)).toEqual(expect.arrayContaining(['liableParty', 'amount']));
  });
});

describe('queue ordering and notifications', () => {
  it('sorts the queue by urgency and response deadline when asked, newest first otherwise', async () => {
    const priority = makeService();
    await priority.service.findAll(Object.assign(new QuerySupportCasesDto(), { sort: 'priority' }));
    expect(priority.queryBuilder.orderBy).toHaveBeenCalledWith('supportCase.status', 'ASC');
    expect(priority.queryBuilder.addOrderBy).toHaveBeenCalledWith('supportCase.isUrgent', 'DESC');
    expect(priority.queryBuilder.addOrderBy).toHaveBeenCalledWith('supportCase.respondBy', 'ASC', 'NULLS LAST');

    const newest = makeService();
    await newest.service.findAll(new QuerySupportCasesDto());
    expect(newest.queryBuilder.orderBy).toHaveBeenCalledWith('supportCase.createdAt', 'DESC');
    expect(newest.queryBuilder.addOrderBy).not.toHaveBeenCalled();
  });

  it('alerts every manager when a case opens, urgently when flagged, and never fails the request', async () => {
    const urgent = makeService();
    await urgent.service.openCaseForActor(
      { caseType: SupportCaseType.PROPERTY_DAMAGE, reason: 'Thợ làm vỡ gạch', serviceOrderId: 'order-1', isUrgent: true } as any,
      { id: 'customer-1', role: Role.CUSTOMER },
    );
    expect(urgent.notifications.createManyNotifications).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'sm-1', type: 'SUPPORT_CASE_URGENT', referenceType: 'SUPPORT_CASE' }),
      expect.objectContaining({ userId: 'sm-2' }),
    ]);

    const failing = makeService();
    failing.notifications.createManyNotifications.mockRejectedValueOnce(new Error('down'));
    await expect(
      failing.service.openCaseForActor(
        { caseType: SupportCaseType.QUALITY, reason: 'Chưa đạt yêu cầu', serviceOrderId: 'order-1' } as any,
        { id: 'customer-1', role: Role.CUSTOMER },
      ),
    ).resolves.toBeDefined();

    const silent = makeService(makeCase(), false);
    await expect(
      silent.service.openCaseForActor(
        { caseType: SupportCaseType.QUALITY, reason: 'Chưa đạt yêu cầu', serviceOrderId: 'order-1' } as any,
        { id: 'customer-1', role: Role.CUSTOMER },
      ),
    ).resolves.toBeDefined();
  });
});

describe('completion hold guard and routing', () => {
  it('is held only while an open case asks for it', async () => {
    const count = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await isCompletionHeld({ count } as any, 'order-1')).toBe(true);
    expect(await isCompletionHeld({ count } as any, 'order-1')).toBe(false);
    expect(count).toHaveBeenCalledWith(
      SupportCase,
      expect.objectContaining({ where: expect.objectContaining({ serviceOrderId: 'order-1', holdCompletion: true }) }),
    );
  });

  it('limits review and hold to service managers with the resolve permission', () => {
    for (const handler of [SupportCasesController.prototype.startReview, SupportCasesController.prototype.setHold]) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.SERVICE_MANAGER]);
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toEqual(['support:resolve']);
    }
  });
});
