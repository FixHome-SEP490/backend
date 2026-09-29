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
  SupportCaseType,
  WarrantyClaimStatus,
  WarrantyStatus,
} from '../../shared/enums';
import {
  CreateWarrantyClaimDto,
  RespondWarrantyClaimDto,
} from './dto/warranty-claim.dto';
import { WarrantyClaimsController } from './warranty-claims.controller';
import { WarrantyClaimsService } from './warranty-claims.service';

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
    manager: { transaction: vi.fn(async (cb: any) => cb({ getRepository: () => txRepo })) },
  };
  const coverageRepo = {
    findOneBy: vi.fn().mockResolvedValue(
      'coverage' in options
        ? options.coverage
        : { id: COVERAGE_ID, serviceOrderId: ORDER_ID, status: WarrantyStatus.ACTIVE, expiresAt: FUTURE },
    ),
  };
  const assignmentRepo = {
    findOne: vi.fn().mockResolvedValue('assignment' in options ? options.assignment : { technicianId: 'tech-1' }),
  };
  const supportCases = { openCase: vi.fn().mockResolvedValue({ id: 'case-9' }) };
  const notifier = { toUser: vi.fn().mockResolvedValue(undefined) };
  const service = new WarrantyClaimsService(
    { manager } as any,
    claimRepo as any,
    coverageRepo as any,
    assignmentRepo as any,
    supportCases as any,
    notifier as any,
  );
  return { service, claimRepo, coverageRepo, assignmentRepo, supportCases, notifier, txRepo, manager };
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

  it('still accepts a claim on an expired coverage but flags it for the manager', async () => {
    const { service, claimRepo } = makeService({
      coverage: { id: COVERAGE_ID, serviceOrderId: ORDER_ID, status: WarrantyStatus.ACTIVE, expiresAt: PAST },
    });

    await service.create(ORDER_ID, createDto(), CUSTOMER);

    expect(claimRepo.save).toHaveBeenCalledWith(expect.objectContaining({ submittedAfterExpiry: true }));
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
    expect(missing.coverageRepo.findOneBy).toHaveBeenCalledWith({
      id: COVERAGE_ID,
      serviceOrderId: ORDER_ID,
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

  it('records that the customer agreed without changing the claim status', async () => {
    const { service, claimRepo } = makeService({ claim: awaiting });

    await service.respond(ORDER_ID, 'claim-1', { decision: 'agree' }, CUSTOMER);

    expect(claimRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claim-1', status: WarrantyClaimStatus.AWAITING_CUSTOMER }),
      expect.objectContaining({ customerResponse: 'agreed' }),
    );
  });

  it('turns a dispute into a warranty dispute case in one transaction', async () => {
    const { service, txRepo, supportCases } = makeService({ claim: awaiting });

    await service.respond(
      ORDER_ID,
      'claim-1',
      { decision: 'dispute', note: 'Lỗi vẫn do linh kiện kỹ thuật viên đã thay' },
      CUSTOMER,
    );

    expect(txRepo.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: WarrantyClaimStatus.AWAITING_CUSTOMER }),
      expect.objectContaining({ status: WarrantyClaimStatus.DISPUTED, customerResponse: 'disputed' }),
    );
    expect(supportCases.openCase).toHaveBeenCalledWith(
      expect.objectContaining({
        caseType: SupportCaseType.WARRANTY_DISPUTE,
        serviceOrderId: ORDER_ID,
        customerId: CUSTOMER.id,
        technicianId: 'tech-1',
      }),
      expect.anything(),
    );
    expect(txRepo.update).toHaveBeenNthCalledWith(2, { id: 'claim-1' }, { escalatedSupportCaseId: 'case-9' });
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
    const { service, claimRepo } = makeService({ claim: awaiting });
    claimRepo.update.mockResolvedValueOnce({ affected: 0 });

    await expect(
      service.respond(ORDER_ID, 'claim-1', { decision: 'agree' }, CUSTOMER),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
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
    for (const handler of [WarrantyClaimsController.prototype.create, WarrantyClaimsController.prototype.respond]) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.CUSTOMER]);
    }
  });
});
