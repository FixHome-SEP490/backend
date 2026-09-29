import 'reflect-metadata';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  Role,
  WarrantyClaimStatus,
  WarrantyCustomerPrompt,
  WarrantyDeclineReason,
  WarrantyInspectionResult,
  WarrantyNotCoveredReason,
  WarrantyVisitStatus,
} from '../../shared/enums';
import {
  DeclineWarrantyClaimDto,
  ProposeWarrantyInspectionDto,
} from './dto/warranty-claim.dto';
import { WarrantyClaimsTechnicianController } from './warranty-claims-technician.controller';
import { WarrantyClaimsTechnicianService } from './warranty-claims-technician.service';

const TECH = { id: 'tech-1', role: Role.TECHNICIAN };

const makeClaim = (overrides: Record<string, unknown> = {}) => ({
  id: 'claim-1',
  serviceOrderId: 'order-1',
  warrantyCoverageId: 'cov-1',
  customerId: 'customer-1',
  technicianId: TECH.id,
  status: WarrantyClaimStatus.SUBMITTED,
  ...overrides,
});
const makeVisit = (overrides: Record<string, unknown> = {}) => ({
  id: 'visit-1',
  warrantyClaimId: 'claim-1',
  technicianId: TECH.id,
  status: WarrantyVisitStatus.SCHEDULED,
  ...overrides,
});

const makeService = (options: { claim?: unknown; visits?: unknown[] } = {}) => {
  const claimTx = { update: vi.fn().mockResolvedValue({ affected: 1 }) };
  const visitTx = {
    update: vi.fn().mockResolvedValue({ affected: 1 }),
    create: vi.fn((v) => v),
    save: vi.fn(async (v) => v),
  };
  const claimRepo = {
    findOne: vi.fn().mockResolvedValue('claim' in options ? options.claim : makeClaim()),
    findOneOrFail: vi.fn().mockResolvedValue(makeClaim()),
    find: vi.fn().mockResolvedValue([makeClaim()]),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
    manager: {
      transaction: vi.fn(async (cb: any) =>
        cb({ getRepository: (entity: { name: string }) => (entity.name === 'WarrantyVisit' ? visitTx : claimTx) }),
      ),
    },
  };
  const visitRepo = {
    find: vi.fn().mockResolvedValue(options.visits ?? [makeVisit()]),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
  };
  const reader = { toStaffViews: vi.fn().mockImplementation(async (claims: any[]) => claims.map((c) => ({ id: c.id }))) };
  const notifier = {
    toUser: vi.fn().mockResolvedValue(undefined),
    toManagers: vi.fn().mockResolvedValue(undefined),
  };
  const service = new WarrantyClaimsTechnicianService(claimRepo as any, visitRepo as any, reader as any, notifier as any);
  return { service, claimRepo, claimTx, visitTx, visitRepo, reader, notifier };
};

describe('technician warranty commands', () => {
  it('accepts a submitted claim, opens a scheduled visit and tells the customer', async () => {
    const { service, claimTx, visitTx, notifier } = makeService();

    await service.accept('claim-1', { scheduledAt: '2026-10-02T02:00:00.000Z' }, TECH);

    expect(claimTx.update).toHaveBeenCalledWith(
      { id: 'claim-1', status: WarrantyClaimStatus.SUBMITTED, technicianId: TECH.id },
      { status: WarrantyClaimStatus.ACCEPTED },
    );
    expect(visitTx.save).toHaveBeenCalledWith(
      expect.objectContaining({
        warrantyClaimId: 'claim-1',
        technicianId: TECH.id,
        status: WarrantyVisitStatus.SCHEDULED,
        scheduledAt: new Date('2026-10-02T02:00:00.000Z'),
      }),
    );
    expect(notifier.toUser).toHaveBeenCalledWith('customer-1', expect.any(String), expect.any(String), 'WARRANTY_CLAIM_ACCEPTED', 'order-1');
  });

  it('answers 404 for a claim assigned to someone else or unassigned, and 409 for the wrong state', async () => {
    const other = makeService({ claim: makeClaim({ technicianId: 'tech-2' }) });
    await expect(other.service.accept('claim-1', {}, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.NOT_FOUND } });

    const unassigned = makeService({ claim: makeClaim({ technicianId: null }) });
    await expect(unassigned.service.accept('claim-1', {}, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.NOT_FOUND } });

    const wrongState = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.INSPECTED }) });
    await expect(wrongState.service.accept('claim-1', {}, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
    expect(wrongState.claimTx.update).not.toHaveBeenCalled();
  });

  it('does not double accept when a concurrent accept wins', async () => {
    const { service, claimTx, visitTx } = makeService();
    claimTx.update.mockResolvedValueOnce({ affected: 0 });

    await expect(service.accept('claim-1', {}, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
    expect(visitTx.save).not.toHaveBeenCalled();
  });

  it('declining unassigns the claim, records who declined and why, and alerts the managers', async () => {
    const { service, claimRepo, notifier } = makeService();

    await service.decline('claim-1', { reasonCode: WarrantyDeclineReason.BUSY }, TECH);

    expect(claimRepo.update).toHaveBeenCalledWith(
      { id: 'claim-1', status: WarrantyClaimStatus.SUBMITTED, technicianId: TECH.id },
      expect.objectContaining({
        technicianId: null,
        declinedByTechnicianId: TECH.id,
        declineReasonCode: WarrantyDeclineReason.BUSY,
        declinedAt: expect.any(Date),
      }),
    );
    expect(notifier.toManagers).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'WARRANTY_REASSIGN_NEEDED', 'order-1');
  });

  it('checks in only once and records the position', async () => {
    const first = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }) });
    await first.service.checkIn('claim-1', { lat: 10.77, lng: 106.7 }, TECH);
    expect(first.visitRepo.update).toHaveBeenCalledWith(
      { id: 'visit-1', status: WarrantyVisitStatus.SCHEDULED },
      expect.objectContaining({ status: WarrantyVisitStatus.CHECKED_IN, checkInLat: '10.77', checkInLng: '106.7' }),
    );

    const repeat = makeService({
      claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }),
      visits: [makeVisit({ status: WarrantyVisitStatus.CHECKED_IN })],
    });
    await repeat.service.checkIn('claim-1', {}, TECH);
    expect(repeat.visitRepo.update).not.toHaveBeenCalled();
  });

  it('proposes a conclusion only after check-in and moves the claim to inspected for manager approval', async () => {
    const early = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }) });
    await expect(
      early.service.propose(
        'claim-1',
        { result: WarrantyInspectionResult.COVERED_PART, findings: 'Linh kiện bị nứt ở mối ghép' },
        TECH,
      ),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });

    const ok = makeService({
      claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }),
      visits: [makeVisit({ status: WarrantyVisitStatus.CHECKED_IN })],
    });
    await ok.service.propose(
      'claim-1',
      { result: WarrantyInspectionResult.COVERED_PART, findings: 'Linh kiện bị nứt ở mối ghép' },
      TECH,
    );
    expect(ok.claimTx.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: WarrantyClaimStatus.ACCEPTED }),
      { status: WarrantyClaimStatus.INSPECTED },
    );
    expect(ok.visitTx.update).toHaveBeenCalledWith(
      { id: 'visit-1', status: WarrantyVisitStatus.CHECKED_IN },
      expect.objectContaining({
        status: WarrantyVisitStatus.INSPECTED,
        proposedResult: WarrantyInspectionResult.COVERED_PART,
        notCoveredReasonCode: null,
      }),
    );
    expect(ok.notifier.toManagers).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'WARRANTY_PROPOSAL_READY', 'order-1');
  });

  it('refuses a not-covered conclusion without evidence and stores the reason when it has one', async () => {
    const setup = () =>
      makeService({
        claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }),
        visits: [makeVisit({ status: WarrantyVisitStatus.CHECKED_IN })],
      });

    const noEvidence = setup();
    await expect(
      noEvidence.service.propose(
        'claim-1',
        {
          result: WarrantyInspectionResult.NOT_COVERED,
          notCoveredReasonCode: WarrantyNotCoveredReason.CUSTOMER_MISUSE,
          findings: 'Khách tự tháo lắp van sau khi sửa',
        },
        TECH,
      ),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
    expect(noEvidence.claimTx.update).not.toHaveBeenCalled();

    const withEvidence = setup();
    await withEvidence.service.propose(
      'claim-1',
      {
        result: WarrantyInspectionResult.NOT_COVERED,
        notCoveredReasonCode: WarrantyNotCoveredReason.CUSTOMER_MISUSE,
        findings: 'Khách tự tháo lắp van sau khi sửa',
        evidenceRefs: ['https://cdn.test/valve.jpg'],
      },
      TECH,
    );
    expect(withEvidence.visitTx.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        notCoveredReasonCode: WarrantyNotCoveredReason.CUSTOMER_MISUSE,
        evidenceRefs: ['https://cdn.test/valve.jpg'],
      }),
    );
  });

  it('completing the re-service hands the claim to the customer for confirmation', async () => {
    const { service, claimTx, visitTx, notifier } = makeService({
      claim: makeClaim({ status: WarrantyClaimStatus.IN_PROGRESS }),
      visits: [makeVisit({ status: WarrantyVisitStatus.INSPECTED })],
    });

    await service.complete('claim-1', { notes: 'Đã thay mới van và kiểm tra rò rỉ' }, TECH);

    expect(claimTx.update).toHaveBeenCalledWith(
      { id: 'claim-1', status: WarrantyClaimStatus.IN_PROGRESS, technicianId: TECH.id },
      expect.objectContaining({
        status: WarrantyClaimStatus.AWAITING_CUSTOMER,
        awaitingPrompt: WarrantyCustomerPrompt.COMPLETION,
        customerResponse: null,
      }),
    );
    expect(visitTx.update).toHaveBeenCalledWith(
      { id: 'visit-1', status: WarrantyVisitStatus.INSPECTED },
      expect.objectContaining({ status: WarrantyVisitStatus.COMPLETED, completedAt: expect.any(Date) }),
    );
    expect(notifier.toUser).toHaveBeenCalledWith('customer-1', expect.any(String), expect.any(String), 'WARRANTY_CUSTOMER_RESPONSE_NEEDED', 'order-1');
  });

  it('lists only the claims assigned to the caller, optionally by status', async () => {
    const { service, claimRepo, reader } = makeService();

    const result = await service.listMine(TECH, WarrantyClaimStatus.ACCEPTED);

    expect(claimRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { technicianId: TECH.id, status: WarrantyClaimStatus.ACCEPTED } }),
    );
    expect(reader.toStaffViews).toHaveBeenCalled();
    expect(result).toEqual([{ id: 'claim-1' }]);
  });
});

describe('technician warranty DTOs and routing', () => {
  it('requires a reason note when declining with "other"', async () => {
    const errors = await validate(
      Object.assign(new DeclineWarrantyClaimDto(), { reasonCode: WarrantyDeclineReason.OTHER }),
    );
    expect(errors.map((e) => e.property)).toContain('note');
    const busy = await validate(Object.assign(new DeclineWarrantyClaimDto(), { reasonCode: WarrantyDeclineReason.BUSY }));
    expect(busy).toHaveLength(0);
  });

  it('requires a reason code and an evidence list for a not-covered proposal', async () => {
    const errors = await validate(
      Object.assign(new ProposeWarrantyInspectionDto(), {
        result: WarrantyInspectionResult.NOT_COVERED,
        findings: 'Khách tự tháo lắp van sau khi sửa',
      }),
    );
    expect(errors.map((e) => e.property)).toEqual(expect.arrayContaining(['notCoveredReasonCode', 'evidenceRefs']));

    const covered = await validate(
      Object.assign(new ProposeWarrantyInspectionDto(), {
        result: WarrantyInspectionResult.COVERED_WORKMANSHIP,
        findings: 'Mối hàn bị hở do thi công chưa kỹ',
      }),
    );
    expect(covered).toHaveLength(0);
  });

  it('is limited to technicians', () => {
    expect(Reflect.getMetadata(ROLES_KEY, WarrantyClaimsTechnicianController)).toEqual([Role.TECHNICIAN]);
  });
});
