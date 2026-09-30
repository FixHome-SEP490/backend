import 'reflect-metadata';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  Role,
  WarrantyClaimStatus,
  WarrantyCustomerPrompt,
  WarrantyInspectionResult,
  WarrantyNotCoveredReason,
  WarrantyVisitStatus,
} from '../../shared/enums';
import {
  CloseWarrantyClaimDto,
  QueryWarrantyClaimsDto,
  RejectWarrantyClaimDto,
} from './dto/warranty-claim.dto';
import { WarrantyClaimsManagerController } from './warranty-claims-manager.controller';
import { WarrantyClaimsManagerService } from './warranty-claims-manager.service';

const SM = { id: 'sm-1', role: Role.SERVICE_MANAGER };

const makeClaim = (overrides: Record<string, unknown> = {}) => ({
  id: 'claim-1',
  serviceOrderId: 'order-1',
  customerId: 'customer-1',
  technicianId: 'tech-1',
  status: WarrantyClaimStatus.INSPECTED,
  customerResponse: null,
  reviewedByManagerId: null,
  ...overrides,
});
const makeVisit = (overrides: Record<string, unknown> = {}) => ({
  id: 'visit-1',
  warrantyClaimId: 'claim-1',
  status: WarrantyVisitStatus.INSPECTED,
  proposedResult: WarrantyInspectionResult.COVERED_PART,
  notCoveredReasonCode: null,
  ...overrides,
});

const makeService = (options: { claim?: unknown; visits?: unknown[]; technician?: unknown; queryRows?: unknown[][] } = {}) => {
  const claimTx = { update: vi.fn().mockResolvedValue({ affected: 1 }) };
  const visitTx = { update: vi.fn().mockResolvedValue({ affected: 1 }) };
  const rows = [...(options.queryRows ?? [])];
  const claimRepo = {
    findOne: vi.fn().mockResolvedValue('claim' in options ? options.claim : makeClaim()),
    findAndCount: vi.fn().mockResolvedValue([[makeClaim()], 1]),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
    manager: {
      transaction: vi.fn(async (cb: any) =>
        cb({ getRepository: (entity: { name: string }) => (entity.name === 'WarrantyVisit' ? visitTx : claimTx) }),
      ),
      query: vi.fn(async () => rows.shift() ?? []),
    },
  };
  const visitRepo = { find: vi.fn().mockResolvedValue(options.visits ?? [makeVisit()]) };
  const userRepo = {
    findOne: vi.fn().mockResolvedValue('technician' in options ? options.technician : { id: 'tech-2', role: Role.TECHNICIAN }),
    find: vi.fn().mockResolvedValue([
      { id: 'tech-1', fullName: 'Kỹ thuật viên A' },
      { id: 'tech-2', fullName: 'Kỹ thuật viên B' },
    ]),
  };
  const reader = { toStaffViews: vi.fn().mockImplementation(async (claims: any[]) => claims.map((c) => ({ id: c.id }))) };
  const notifier = { toUser: vi.fn().mockResolvedValue(undefined), toManagers: vi.fn() };
  const auditLog = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new WarrantyClaimsManagerService(
    claimRepo as any,
    visitRepo as any,
    userRepo as any,
    reader as any,
    notifier as any,
    auditLog as any,
  );
  return { service, claimRepo, claimTx, visitTx, visitRepo, userRepo, reader, notifier, auditLog };
};

describe('manager warranty queue', () => {
  it('filters by status and by unassigned claims with bounded pages', async () => {
    const { service, claimRepo } = makeService();

    const result = await service.list(
      Object.assign(new QueryWarrantyClaimsDto(), { page: 2, limit: 10, status: WarrantyClaimStatus.SUBMITTED, unassigned: true }),
    );

    const arg = claimRepo.findAndCount.mock.calls[0][0];
    expect(arg.where.status).toBe(WarrantyClaimStatus.SUBMITTED);
    expect(arg.where.technicianId).toBeDefined();
    expect(arg.skip).toBe(10);
    expect(arg.take).toBe(10);
    expect(result).toEqual({ data: [{ id: 'claim-1' }], total: 1 });
  });

  it('answers 404 for an unknown claim', async () => {
    const { service } = makeService({ claim: null });
    await expect(service.get('missing')).rejects.toMatchObject({ response: { code: ErrorCodes.NOT_FOUND } });
  });
});

describe('eligible technicians', () => {
  it('lists only active technician accounts, sorted by name', async () => {
    const { service, userRepo } = makeService();

    const result = await service.eligibleTechnicians();

    expect(userRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: Role.TECHNICIAN, isActive: true }),
        order: { fullName: 'ASC' },
      }),
    );
    expect(result).toEqual([
      { id: 'tech-1', fullName: 'Kỹ thuật viên A' },
      { id: 'tech-2', fullName: 'Kỹ thuật viên B' },
    ]);
  });
});

describe('manager assign', () => {
  it('hands the claim to another technician, restarts it and cancels open visits', async () => {
    const { service, claimTx, visitTx, notifier, auditLog } = makeService({
      claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }),
    });

    await service.assign('claim-1', { technicianId: 'tech-2' }, SM);

    expect(claimTx.update).toHaveBeenCalledWith(
      { id: 'claim-1', status: WarrantyClaimStatus.ACCEPTED },
      { technicianId: 'tech-2', status: WarrantyClaimStatus.SUBMITTED },
    );
    expect(visitTx.update).toHaveBeenCalledWith(
      expect.objectContaining({ warrantyClaimId: 'claim-1' }),
      { status: WarrantyVisitStatus.CANCELLED },
    );
    expect(notifier.toUser).toHaveBeenCalledWith('tech-2', expect.any(String), expect.any(String), 'WARRANTY_INSPECTION_ASSIGNED', 'order-1');
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WARRANTY_CLAIM_ASSIGNED', resourceId: 'claim-1', actorUserId: 'sm-1' }),
    );
  });

  it('refuses a claim past inspection, a non-technician, and a lost race', async () => {
    const past = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.IN_PROGRESS }) });
    await expect(past.service.assign('claim-1', { technicianId: 'tech-2' }, SM)).rejects.toMatchObject({
      response: { code: ErrorCodes.CONFLICT },
    });

    const notTech = makeService({ technician: null });
    await expect(notTech.service.assign('claim-1', { technicianId: 'user-9' }, SM)).rejects.toMatchObject({
      response: { code: ErrorCodes.VALIDATION_FAILED },
    });

    const race = makeService();
    race.claimTx.update.mockResolvedValueOnce({ affected: 0 });
    await expect(race.service.assign('claim-1', { technicianId: 'tech-2' }, SM)).rejects.toMatchObject({
      response: { code: ErrorCodes.CONFLICT },
    });
  });
});

describe('manager approve', () => {
  it('approves a covered proposal: work starts and nothing is flagged as overridden', async () => {
    const { service, claimRepo, notifier, auditLog } = makeService();

    await service.approve('claim-1', {}, SM);

    expect(claimRepo.update).toHaveBeenCalledWith(
      { id: 'claim-1', status: WarrantyClaimStatus.INSPECTED },
      expect.objectContaining({
        status: WarrantyClaimStatus.IN_PROGRESS,
        awaitingPrompt: null,
        finalResult: WarrantyInspectionResult.COVERED_PART,
        smOverrodeProposal: false,
        reviewedByManagerId: 'sm-1',
      }),
    );
    expect(notifier.toUser).toHaveBeenCalledWith('tech-1', expect.any(String), expect.any(String), 'WARRANTY_APPROVED', 'order-1');
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'WARRANTY_PROPOSAL_APPROVED' }));
  });

  it('turns an approved not-covered proposal into a question for the customer', async () => {
    const { service, claimRepo, notifier } = makeService({
      visits: [makeVisit({ proposedResult: WarrantyInspectionResult.NOT_COVERED, notCoveredReasonCode: WarrantyNotCoveredReason.CUSTOMER_MISUSE })],
    });

    await service.approve('claim-1', { customerNote: 'Lỗi do khách tự tháo lắp van sau khi sửa.' }, SM);

    expect(claimRepo.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: WarrantyClaimStatus.AWAITING_CUSTOMER,
        awaitingPrompt: WarrantyCustomerPrompt.CONCLUSION,
        customerResponse: null,
        resolutionNotes: 'Lỗi do khách tự tháo lắp van sau khi sửa.',
        finalReasonCode: WarrantyNotCoveredReason.CUSTOMER_MISUSE,
      }),
    );
    expect(notifier.toUser).toHaveBeenCalledWith('customer-1', expect.any(String), expect.any(String), 'WARRANTY_CUSTOMER_RESPONSE_NEEDED', 'order-1');
  });

  it('records when the manager overrides the technician and demands a note and reason for not covered', async () => {
    const noNote = makeService();
    await expect(
      noNote.service.approve('claim-1', { result: WarrantyInspectionResult.NOT_COVERED, reasonCode: WarrantyNotCoveredReason.NORMAL_WEAR }, SM),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });

    const noReason = makeService();
    await expect(
      noReason.service.approve('claim-1', { result: WarrantyInspectionResult.NOT_COVERED, customerNote: 'Linh kiện đã hao mòn tự nhiên.' }, SM),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });

    const ok = makeService();
    await ok.service.approve(
      'claim-1',
      { result: WarrantyInspectionResult.NOT_COVERED, reasonCode: WarrantyNotCoveredReason.NORMAL_WEAR, customerNote: 'Linh kiện đã hao mòn tự nhiên.' },
      SM,
    );
    expect(ok.claimRepo.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ smOverrodeProposal: true, finalResult: WarrantyInspectionResult.NOT_COVERED }),
    );
  });

  it('needs a proposal to approve and refuses a claim in another state or a lost race', async () => {
    const none = makeService({ visits: [] });
    await expect(none.service.approve('claim-1', {}, SM)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });

    const wrong = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }) });
    await expect(wrong.service.approve('claim-1', {}, SM)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });

    const race = makeService();
    race.claimRepo.update.mockResolvedValueOnce({ affected: 0 });
    await expect(race.service.approve('claim-1', {}, SM)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
  });
});

describe('manager reject and close', () => {
  it('rejects with a customer-facing reason, closes open visits and tells both sides', async () => {
    const { service, claimTx, visitTx, notifier } = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.SUBMITTED }) });

    await service.reject(
      'claim-1',
      { reasonCode: WarrantyNotCoveredReason.EXPIRED, customerNote: 'Hạng mục đã hết hạn bảo hành từ tuần trước.' },
      SM,
    );

    expect(claimTx.update).toHaveBeenCalledWith(
      { id: 'claim-1', status: WarrantyClaimStatus.SUBMITTED },
      expect.objectContaining({
        status: WarrantyClaimStatus.REJECTED,
        finalReasonCode: WarrantyNotCoveredReason.EXPIRED,
        resolutionNotes: 'Hạng mục đã hết hạn bảo hành từ tuần trước.',
        resolvedAt: expect.any(Date),
      }),
    );
    expect(visitTx.update).toHaveBeenCalled();
    expect(notifier.toUser).toHaveBeenCalledTimes(2);
  });

  it('closes after the customer agreed without asking for a note, otherwise requires one', async () => {
    const agreed = makeService({
      claim: makeClaim({ status: WarrantyClaimStatus.AWAITING_CUSTOMER, customerResponse: 'agreed', reviewedByManagerId: 'sm-1' }),
    });
    await agreed.service.close('claim-1', { outcome: 'rejected' }, SM);
    expect(agreed.claimRepo.update).toHaveBeenCalledWith(
      { id: 'claim-1', status: WarrantyClaimStatus.AWAITING_CUSTOMER },
      expect.objectContaining({ status: WarrantyClaimStatus.REJECTED, resolvedAt: expect.any(Date) }),
    );

    const silent = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.AWAITING_CUSTOMER, customerResponse: null }) });
    await expect(silent.service.close('claim-1', { outcome: 'rejected' }, SM)).rejects.toMatchObject({
      response: { code: ErrorCodes.VALIDATION_FAILED },
    });
  });

  it('sends a disputed claim to a different manager than the one who reviewed it', async () => {
    const same = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.DISPUTED, reviewedByManagerId: 'sm-1' }) });
    await expect(
      same.service.close('claim-1', { outcome: 'resolved', note: 'Đã xem lại bằng chứng của hai bên.' }, SM),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.RBAC_FORBIDDEN } });

    const other = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.DISPUTED, reviewedByManagerId: 'sm-1' }) });
    await other.service.close('claim-1', { outcome: 'resolved', note: 'Đã xem lại bằng chứng của hai bên.' }, { id: 'sm-2', role: Role.SERVICE_MANAGER });
    expect(other.claimRepo.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: WarrantyClaimStatus.RESOLVED, resolutionNotes: 'Đã xem lại bằng chứng của hai bên.' }),
    );
  });
});

describe('technician warranty rates', () => {
  it('computes rates from the aggregates and flags small samples', async () => {
    const { service } = makeService({
      queryRows: [
        [{ technician_id: 'tech-1', orders: '20' }, { technician_id: 'tech-2', orders: '4' }],
        [
          { technician_id: 'tech-1', claims: '4', covered: '2', not_covered: '2', overridden: '1', decided: '4', disputed: '1' },
          { technician_id: 'tech-2', claims: '1', covered: '0', not_covered: '1', overridden: '0', decided: '1', disputed: '0' },
        ],
        [{ technician_id: 'tech-1', declines: '1' }],
      ],
    });

    const stats = await service.technicianStats(90);

    expect(stats.map((row) => row.technicianId)).toEqual(['tech-2', 'tech-1']);
    expect(stats.find((row) => row.technicianId === 'tech-1')).toMatchObject({
      technicianId: 'tech-1',
      fullName: 'Kỹ thuật viên A',
      ordersWithWarranty: 20,
      claims: 4,
      claimRate: 0.2,
      notCoveredRate: 0.5,
      overriddenRate: 0.25,
      disputedRate: 0.5,
      declines: 1,
      declineRate: 0.2,
      lowSample: false,
    });
    expect(stats[0]).toMatchObject({ technicianId: 'tech-2', claimRate: 0.25, lowSample: true });
  });

  it('returns an empty list and no rates without a denominator', async () => {
    const empty = makeService({ queryRows: [[], [], []] });
    expect(await empty.service.technicianStats()).toEqual([]);

    const onlyDeclines = makeService({ queryRows: [[], [], [{ technician_id: 'tech-1', declines: '2' }]] });
    const [row] = await onlyDeclines.service.technicianStats();
    expect(row).toMatchObject({ claimRate: null, declines: 2, lowSample: true });
  });
});

describe('manager warranty DTOs and access', () => {
  it('needs a written explanation for a rejection', async () => {
    const errors = await validate(
      Object.assign(new RejectWarrantyClaimDto(), { reasonCode: WarrantyNotCoveredReason.EXPIRED, customerNote: 'ngắn' }),
    );
    expect(errors.map((e) => e.property)).toContain('customerNote');
    const bad = await validate(Object.assign(new CloseWarrantyClaimDto(), { outcome: 'maybe' }));
    expect(bad.map((e) => e.property)).toContain('outcome');
  });

  it('keeps reads open to managers and admins but decisions to service managers with the resolve permission', () => {
    const proto = WarrantyClaimsManagerController.prototype;
    expect(Reflect.getMetadata(ROLES_KEY, WarrantyClaimsManagerController)).toEqual([Role.SERVICE_MANAGER, Role.ADMIN]);
    expect(Reflect.getMetadata(PERMISSION_KEY, WarrantyClaimsManagerController)).toEqual(['support:read_all']);
    for (const handler of [proto.assign, proto.approve, proto.reject, proto.close]) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.SERVICE_MANAGER]);
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toEqual(['support:resolve']);
    }
  });
});
