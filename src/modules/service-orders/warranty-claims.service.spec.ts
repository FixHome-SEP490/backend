import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  Role,
  ServiceOrderStatus,
  WarrantyClaimStatus,
  WarrantyCustomerPrompt,
  WarrantyStatus,
} from '../../shared/enums';
import {
  CreateWarrantyClaimDto,
  RespondWarrantyClaimDto,
} from './dto/warranty-claim.dto';
import { WarrantyClaimsController } from './warranty-claims.controller';
import { WarrantyClaimsService } from './warranty-claims.service';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { User } from '../users/entities/user.entity';

const CUSTOMER = { id: 'customer-1', role: Role.CUSTOMER };
const ORDER_ID = 'order-1';
const COVERAGE_ID = '11111111-1111-4111-8111-111111111111';

const FUTURE = new Date(Date.now() + 10 * 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);

const makeClaim = (overrides: Record<string, unknown> = {}) => ({
  id: 'claim-1',
  serviceOrderId: ORDER_ID,
  warrantyCoverageId: COVERAGE_ID,
  customerId: CUSTOMER.id,
  technicianId: 'tech-1',
  description: 'Vòi nước lại rò rỉ sau ba ngày',
  evidenceRefs: null,
  status: WarrantyClaimStatus.SUBMITTED,
  submittedAfterExpiry: false,
  customerResponse: null,
  resolutionNotes: null,
  submittedAt: new Date('2026-09-29T08:00:00.000Z'),
  resolvedAt: null,
  technician: { id: 'tech-1', fullName: 'Kỹ thuật viên A', passwordHash: 'secret', phoneNumber: '0900' },
  ...overrides,
});

const makeService = (options: {
  orderStatus?: ServiceOrderStatus;
  coverage?: Record<string, unknown> | null;
  openClaim?: unknown;
  assignment?: unknown;
  claim?: unknown;
  forbidden?: boolean;
  technicianActive?: boolean;
} = {}) => {
  const order = {
    id: ORDER_ID,
    code: 'SO-1',
    bookingId: 'booking-1',
    status: options.orderStatus ?? ServiceOrderStatus.COMPLETED,
  };
  const manager = {
    findOne: vi.fn().mockResolvedValue(order),
    findOneBy: vi.fn().mockImplementation(async () =>
      options.forbidden ? null : { id: 'booking-1', customerId: CUSTOMER.id },
    ),
  };
  const txRepo = {
    update: vi.fn().mockResolvedValue({ affected: 1 }),
  };
  const claimRepo = {
    findOne: vi.fn().mockImplementation(async ({ where }: any) => {
      if (where.warrantyCoverageId) return options.openClaim ?? null;
      return 'claim' in options ? options.claim : makeClaim();
    }),
    findOneOrFail: vi.fn().mockResolvedValue(makeClaim()),
    find: vi.fn().mockResolvedValue([makeClaim()]),
    create: vi.fn((v) => ({ id: 'claim-new', ...v })),
    save: vi.fn(async (v) => v),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
    manager: { find: vi.fn(async () => []), transaction: vi.fn(async (cb: any) => cb({ getRepository: () => txRepo })) },
  };
  const coverageRepo = {
    findOne: vi.fn().mockResolvedValue(
      'coverage' in options
        ? options.coverage
        : { id: COVERAGE_ID, serviceOrderId: ORDER_ID, status: WarrantyStatus.ACTIVE, expiresAt: FUTURE },
    ),
  };
  const assignmentRepo = {
    findOne: vi.fn().mockResolvedValue('assignment' in options ? options.assignment : { technicianId: 'tech-1' }),
  };
  const userRepo = {
    findOne: vi.fn().mockImplementation(async ({ where }: any) => ('technicianActive' in options && !options.technicianActive ? null : { id: where.id })),
  };
  const partRequests = { settleWarrantyRequest: vi.fn().mockResolvedValue(undefined) };
  const notifier = { toUser: vi.fn().mockResolvedValue(undefined), toManagers: vi.fn().mockResolvedValue(undefined) };
  const dataSource = {
    manager,
    transaction: vi.fn(async (_isolation: string, cb: any) => cb({
      getRepository: (entity: unknown) => {
        if (entity === WarrantyCoverage) return coverageRepo;
        if (entity === WarrantyClaim) return claimRepo;
        if (entity === TechnicianAssignment) return assignmentRepo;
        if (entity === User) return userRepo;
        throw new Error('Unexpected transaction repository');
      },
    })),
  };
  const service = new WarrantyClaimsService(
    dataSource as any,
    claimRepo as any,
    partRequests as any,
    notifier as any,
  );
  return { service, claimRepo, coverageRepo, assignmentRepo, partRequests, notifier, txRepo, manager };
};

const createDto = (overrides = {}) =>
  ({ warrantyCoverageId: COVERAGE_ID, description: 'Vòi nước lại rò rỉ sau ba ngày', ...overrides }) as any;

describe('WarrantyClaimsService.create', () => {
  it('saves a claim on the coverage, hands it to the technician who did the job and notifies them', async () => {
    const { service, claimRepo, notifier } = makeService();

    const view = await service.create(ORDER_ID, createDto({ evidenceRefs: ['https://cdn.test/a.jpg'] }), CUSTOMER);

    expect(claimRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceOrderId: ORDER_ID,
        warrantyCoverageId: COVERAGE_ID,
        customerId: CUSTOMER.id,
        technicianId: 'tech-1',
        status: WarrantyClaimStatus.SUBMITTED,
        submittedAfterExpiry: false,
        evidenceRefs: ['https://cdn.test/a.jpg'],
      }),
    );
    expect(notifier.toUser).toHaveBeenCalledWith(
      'tech-1',
      expect.any(String),
      expect.any(String),
      'WARRANTY_CLAIM_SUBMITTED',
      ORDER_ID,
    );
    expect(view.technician).toEqual({ id: 'tech-1', fullName: 'Kỹ thuật viên A' });
    expect(JSON.stringify(view)).not.toContain('secret');
    expect(JSON.stringify(view)).not.toContain('0900');
  });

  it('refuses a claim on a coverage that has expired', async () => {
    const { service, claimRepo } = makeService({
      coverage: { id: COVERAGE_ID, serviceOrderId: ORDER_ID, status: WarrantyStatus.ACTIVE, expiresAt: PAST },
    });

    await expect(service.create(ORDER_ID, createDto(), CUSTOMER)).rejects.toMatchObject({
      response: { code: ErrorCodes.VALIDATION_FAILED },
    });
    expect(claimRepo.save).not.toHaveBeenCalled();
  });

  it('keeps the claim unassigned when no technician can be found', async () => {
    const { service, claimRepo, notifier } = makeService({ assignment: null });

    await service.create(ORDER_ID, createDto(), CUSTOMER);

    expect(claimRepo.save).toHaveBeenCalledWith(expect.objectContaining({ technicianId: null }));
    expect(notifier.toUser).toHaveBeenCalledWith(
      null,
      expect.any(String),
      expect.any(String),
      'WARRANTY_CLAIM_SUBMITTED',
      ORDER_ID,
    );
  });

  it('leaves the claim unassigned and tells the managers when the technician who did the job is no longer active', async () => {
    const { service, claimRepo, notifier } = makeService({ technicianActive: false });

    await service.create(ORDER_ID, createDto(), CUSTOMER);

    expect(claimRepo.save).toHaveBeenCalledWith(expect.objectContaining({ technicianId: null }));
    expect(notifier.toManagers).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'WARRANTY_REASSIGN_NEEDED', ORDER_ID);
  });

  it('rejects an order that is not completed', async () => {
    const { service, claimRepo } = makeService({ orderStatus: ServiceOrderStatus.UNDER_REPAIR });

    await expect(service.create(ORDER_ID, createDto(), CUSTOMER)).rejects.toMatchObject({
      response: { code: ErrorCodes.ORDER_INVALID_TRANSITION },
    });
    expect(claimRepo.save).not.toHaveBeenCalled();
  });

  it('rejects a coverage that belongs to another order or is voided', async () => {
    const missing = makeService({ coverage: null });
    await expect(missing.service.create(ORDER_ID, createDto(), CUSTOMER)).rejects.toMatchObject({
      response: { code: ErrorCodes.NOT_FOUND },
    });
    expect(missing.coverageRepo.findOne).toHaveBeenCalledWith({
      where: { id: COVERAGE_ID, serviceOrderId: ORDER_ID },
      lock: { mode: 'pessimistic_write' },
    });

    const voided = makeService({
      coverage: { id: COVERAGE_ID, serviceOrderId: ORDER_ID, status: WarrantyStatus.VOIDED, expiresAt: FUTURE },
    });
    await expect(voided.service.create(ORDER_ID, createDto(), CUSTOMER)).rejects.toMatchObject({
      response: { code: ErrorCodes.VALIDATION_FAILED },
    });
  });

  it('allows one open claim per coverage', async () => {
    const { service, claimRepo } = makeService({ openClaim: makeClaim() });

    await expect(service.create(ORDER_ID, createDto(), CUSTOMER)).rejects.toMatchObject({
      response: { code: ErrorCodes.CONFLICT },
    });
    expect(claimRepo.save).not.toHaveBeenCalled();
  });

  it('refuses a customer who does not own the order', async () => {
    const { service, claimRepo } = makeService({ forbidden: true });

    await expect(service.create(ORDER_ID, createDto(), CUSTOMER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(claimRepo.save).not.toHaveBeenCalled();
  });
});

describe('WarrantyClaimsService.respond', () => {
  const awaiting = makeClaim({ status: WarrantyClaimStatus.AWAITING_CUSTOMER });

  const asking = (prompt: WarrantyCustomerPrompt | null) => makeClaim({ status: WarrantyClaimStatus.AWAITING_CUSTOMER, awaitingPrompt: prompt });

  it('closes the claim as fixed when the customer confirms the finished work, and settles the part request', async () => {
    const { service, txRepo, partRequests, notifier } = makeService({ claim: asking(WarrantyCustomerPrompt.COMPLETION) });

    await service.respond(ORDER_ID, 'claim-1', { decision: 'agree' }, CUSTOMER);

    expect(txRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claim-1', status: WarrantyClaimStatus.AWAITING_CUSTOMER }),
      expect.objectContaining({ status: WarrantyClaimStatus.RESOLVED, outcomeCode: 'fixed', customerResponse: 'agreed' }),
    );
    expect(partRequests.settleWarrantyRequest).toHaveBeenCalledWith(expect.anything(), 'claim-1');
    expect(notifier.toUser).toHaveBeenCalledWith('tech-1', expect.any(String), expect.any(String), 'WARRANTY_DECISION_MADE', ORDER_ID);
    expect(notifier.toManagers).not.toHaveBeenCalled();
  });

  it('closes the claim as rejected when the customer accepts a not-covered conclusion', async () => {
    const { service, txRepo } = makeService({ claim: asking(WarrantyCustomerPrompt.CONCLUSION) });

    await service.respond(ORDER_ID, 'claim-1', { decision: 'agree' }, CUSTOMER);

    expect(txRepo.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: WarrantyClaimStatus.REJECTED, outcomeCode: 'rejected', customerResponse: 'agreed' }),
    );
  });

  it('leaves the close to a manager when the claim has no recorded question', async () => {
    const { service, txRepo, partRequests, notifier } = makeService({ claim: asking(null) });

    await service.respond(ORDER_ID, 'claim-1', { decision: 'agree' }, CUSTOMER);

    expect(txRepo.update).toHaveBeenCalledWith(expect.anything(), { customerResponse: 'agreed', customerRespondedAt: expect.any(Date) });
    expect(partRequests.settleWarrantyRequest).not.toHaveBeenCalled();
    expect(notifier.toManagers).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'WARRANTY_CUSTOMER_RESPONSE_NEEDED', ORDER_ID);
  });

  it('turns a dispute into a disputed claim that keeps the customer reason, with no separate case', async () => {
    const { service, claimRepo, notifier } = makeService({ claim: awaiting });

    await service.respond(
      ORDER_ID,
      'claim-1',
      { decision: 'dispute', note: 'Lỗi vẫn do linh kiện kỹ thuật viên đã thay' },
      CUSTOMER,
    );

    expect(claimRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: WarrantyClaimStatus.AWAITING_CUSTOMER }),
      expect.objectContaining({
        status: WarrantyClaimStatus.DISPUTED,
        customerResponse: 'disputed',
        customerResponseNote: 'Lỗi vẫn do linh kiện kỹ thuật viên đã thay',
      }),
    );
    expect(notifier.toManagers).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'WARRANTY_CUSTOMER_RESPONSE_NEEDED', ORDER_ID);
  });

  it('answers 404 for a claim that is not the caller\'s and 409 when it is not waiting', async () => {
    const foreign = makeService({ claim: makeClaim({ customerId: 'someone-else', status: WarrantyClaimStatus.AWAITING_CUSTOMER }) });
    await expect(
      foreign.service.respond(ORDER_ID, 'claim-1', { decision: 'agree' }, CUSTOMER),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.NOT_FOUND } });

    const notWaiting = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.SUBMITTED }) });
    await expect(
      notWaiting.service.respond(ORDER_ID, 'claim-1', { decision: 'agree' }, CUSTOMER),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });

    const answered = makeService({
      claim: makeClaim({ status: WarrantyClaimStatus.AWAITING_CUSTOMER, customerResponse: 'agreed' }),
    });
    await expect(
      answered.service.respond(ORDER_ID, 'claim-1', { decision: 'agree' }, CUSTOMER),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('does not answer twice when a concurrent response wins the race', async () => {
    const agree = makeService({ claim: asking(WarrantyCustomerPrompt.COMPLETION) });
    agree.txRepo.update.mockResolvedValueOnce({ affected: 0 });
    await expect(
      agree.service.respond(ORDER_ID, 'claim-1', { decision: 'agree' }, CUSTOMER),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
    expect(agree.partRequests.settleWarrantyRequest).not.toHaveBeenCalled();

    const dispute = makeService({ claim: awaiting });
    dispute.claimRepo.update.mockResolvedValueOnce({ affected: 0 });
    await expect(
      dispute.service.respond(ORDER_ID, 'claim-1', { decision: 'dispute', note: 'Lỗi vẫn còn nguyên như cũ' }, CUSTOMER),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
  });
});

describe('WarrantyClaimsService.cancel', () => {
  it('withdraws a claim nobody accepted yet and tells the technician', async () => {
    const { service, claimRepo, notifier } = makeService();

    await service.cancel(ORDER_ID, 'claim-1', CUSTOMER);

    expect(claimRepo.update).toHaveBeenCalledWith(
      { id: 'claim-1', status: WarrantyClaimStatus.SUBMITTED },
      expect.objectContaining({ status: WarrantyClaimStatus.REJECTED, outcomeCode: 'rejected', resolvedAt: expect.any(Date) }),
    );
    expect(notifier.toUser).toHaveBeenCalledWith('tech-1', expect.any(String), expect.any(String), 'WARRANTY_DECISION_MADE', ORDER_ID);
  });

  it("answers 404 for a claim that is not the caller's and 409 once the technician took it", async () => {
    const foreign = makeService({ claim: makeClaim({ customerId: 'someone-else' }) });
    await expect(foreign.service.cancel(ORDER_ID, 'claim-1', CUSTOMER)).rejects.toMatchObject({ response: { code: ErrorCodes.NOT_FOUND } });

    const taken = makeService();
    taken.claimRepo.update.mockResolvedValueOnce({ affected: 0 });
    await expect(taken.service.cancel(ORDER_ID, 'claim-1', CUSTOMER)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
  });
});

describe('WarrantyClaimsService.list', () => {
  it('returns a safe view without technician contact data', async () => {
    const { service } = makeService();

    const [view] = await service.list(ORDER_ID, CUSTOMER);

    expect(view.technician).toEqual({ id: 'tech-1', fullName: 'Kỹ thuật viên A' });
    expect(JSON.stringify(view)).not.toContain('passwordHash');
    expect(JSON.stringify(view)).not.toContain('phoneNumber');
  });
});

describe('warranty claim DTO validation and routing', () => {
  it('requires a coverage id and a meaningful description and bounds the evidence list', async () => {
    const errors = await validate(
      Object.assign(new CreateWarrantyClaimDto(), {
        warrantyCoverageId: 'not-a-uuid',
        description: 'ngắn',
        evidenceRefs: Array.from({ length: 11 }, () => 'https://cdn.test/x.jpg'),
      }),
    );
    expect(errors.map((e) => e.property)).toEqual(
      expect.arrayContaining(['warrantyCoverageId', 'description', 'evidenceRefs']),
    );
  });

  it('requires a reason when the customer disputes', async () => {
    const dispute = await validate(Object.assign(new RespondWarrantyClaimDto(), { decision: 'dispute' }));
    expect(dispute.map((e) => e.property)).toContain('note');
    const agree = await validate(Object.assign(new RespondWarrantyClaimDto(), { decision: 'agree' }));
    expect(agree).toHaveLength(0);
  });

  it('limits submit and respond to customers', () => {
    for (const handler of [WarrantyClaimsController.prototype.create, WarrantyClaimsController.prototype.respond, WarrantyClaimsController.prototype.cancel]) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.CUSTOMER]);
    }
  });
});
