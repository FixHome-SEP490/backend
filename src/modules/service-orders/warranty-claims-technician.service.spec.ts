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

const LINE_1 = '11111111-1111-4111-8111-111111111111';
const LINE_2 = '22222222-2222-4222-8222-222222222222';

const makeService = (options: { claim?: unknown; visits?: unknown[]; profile?: unknown; coverage?: unknown; booking?: unknown; partLines?: unknown[] } = {}) => {
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
    findAndCount: vi.fn().mockResolvedValue([[makeClaim()], 1]),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
    manager: {
      transaction: vi.fn(async (cb: any) =>
        cb({ getRepository: (entity: { name: string }) => (entity.name === 'WarrantyVisit' ? visitTx : claimTx) }),
      ),
      // The technician's own records a decline reason is checked against.
      findOneBy: vi.fn(async (entity: { name: string }) => {
        switch (entity.name) {
          case 'TechnicianProfile':
            return 'profile' in options ? options.profile : { id: 'prof-1', isAvailable: true, workSuspendedUntil: null, serviceRadiusKm: 10 };
          case 'WarrantyCoverage':
            return options.coverage ?? { expiresAt: new Date(Date.now() + 20 * 86_400_000) };
          case 'ServiceOrder':
            return { id: 'order-1', bookingId: 'booking-1' };
          case 'Booking':
            return options.booking ?? { latitudeSnapshot: 10.77, longitudeSnapshot: 106.7, provinceSnapshot: '79', districtSnapshot: '760' };
          case 'Address':
            return { lat: 10.78, lng: 106.69 };
          case 'Invoice':
            return { id: 'inv-1' };
          default:
            return null;
        }
      }),
      find: vi.fn(async (entity: { name: string }) => (entity.name === 'InvoiceItem' ? options.partLines ?? [{ id: LINE_1 }, { id: LINE_2 }] : [])),
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

describe('technician reads one claim', () => {
  it('returns my own claim as the staff view', async () => {
    const { service, claimRepo } = makeService();
    const view = await service.getMine('claim-1', TECH);
    expect(claimRepo.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'claim-1', technicianId: TECH.id } }));
    expect(view).toEqual({ id: 'claim-1' });
  });

  it('answers not found for a claim that is not assigned to me, instead of confirming it exists', async () => {
    const { service } = makeService({ claim: null });
    await expect(service.getMine('claim-1', TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.NOT_FOUND } });
  });
});

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

describe('technician warranty commands', () => {
  it('accepts a submitted claim, opens a scheduled visit and tells the customer', async () => {
    const { service, claimTx, visitTx, notifier } = makeService();

    await service.accept('claim-1', { scheduledAt: FUTURE }, TECH);

    expect(claimTx.update).toHaveBeenCalledWith(
      { id: 'claim-1', status: WarrantyClaimStatus.SUBMITTED, technicianId: TECH.id },
      { status: WarrantyClaimStatus.ACCEPTED },
    );
    expect(visitTx.save).toHaveBeenCalledWith(
      expect.objectContaining({
        warrantyClaimId: 'claim-1',
        technicianId: TECH.id,
        status: WarrantyVisitStatus.SCHEDULED,
        scheduledAt: new Date(FUTURE),
      }),
    );
    expect(notifier.toUser).toHaveBeenCalledWith('customer-1', expect.any(String), expect.any(String), 'WARRANTY_CLAIM_ACCEPTED', 'order-1');
  });

  it('refuses an inspection time that is not in the future', async () => {
    const { service } = makeService();
    await expect(service.accept('claim-1', { scheduledAt: '2020-01-01T00:00:00.000Z' }, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
  });

  it('answers 404 for a claim assigned to someone else or unassigned, and 409 for the wrong state', async () => {
    const other = makeService({ claim: makeClaim({ technicianId: 'tech-2' }) });
    await expect(other.service.accept('claim-1', { scheduledAt: FUTURE }, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.NOT_FOUND } });

    const unassigned = makeService({ claim: makeClaim({ technicianId: null }) });
    await expect(unassigned.service.accept('claim-1', { scheduledAt: FUTURE }, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.NOT_FOUND } });

    const wrongState = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.INSPECTED }) });
    await expect(wrongState.service.accept('claim-1', { scheduledAt: FUTURE }, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
    expect(wrongState.claimTx.update).not.toHaveBeenCalled();
  });

  it('does not double accept when a concurrent accept wins', async () => {
    const { service, claimTx, visitTx } = makeService();
    claimTx.update.mockResolvedValueOnce({ affected: 0 });

    await expect(service.accept('claim-1', { scheduledAt: FUTURE }, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
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
        declineReview: 'pending',
      }),
    );
    expect(notifier.toManagers).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'WARRANTY_REASSIGN_NEEDED', 'order-1');
  });

  it('verifies on-leave and out-of-area declines against the technician records; anything else waits for a manager', async () => {
    const reviewOf = async (reason: WarrantyDeclineReason, options: Parameters<typeof makeService>[0] = {}) => {
      const { service, claimRepo } = makeService(options);
      await service.decline('claim-1', { reasonCode: reason, ...(reason === WarrantyDeclineReason.OTHER ? { note: 'Có việc gia đình đột xuất.' } : {}) }, TECH);
      return claimRepo.update.mock.calls[0][1].declineReview;
    };
    const paused = { id: 'prof-1', isAvailable: false, workSuspendedUntil: null, serviceRadiusKm: 10 };
    const suspended = { id: 'prof-1', isAvailable: true, workSuspendedUntil: new Date(Date.now() + 86_400_000), serviceRadiusKm: 10 };
    const faraway = { latitudeSnapshot: 21.03, longitudeSnapshot: 105.85, provinceSnapshot: '01', districtSnapshot: '001' };

    expect(await reviewOf(WarrantyDeclineReason.ON_LEAVE, { profile: paused })).toBe('valid');
    expect(await reviewOf(WarrantyDeclineReason.ON_LEAVE, { profile: suspended })).toBe('valid');
    expect(await reviewOf(WarrantyDeclineReason.ON_LEAVE)).toBe('pending');
    expect(await reviewOf(WarrantyDeclineReason.OUT_OF_AREA, { booking: faraway })).toBe('valid');
    expect(await reviewOf(WarrantyDeclineReason.OUT_OF_AREA)).toBe('pending');
    expect(await reviewOf(WarrantyDeclineReason.BUSY)).toBe('pending');
    expect(await reviewOf(WarrantyDeclineReason.OTHER)).toBe('pending');
    expect(await reviewOf(WarrantyDeclineReason.ON_LEAVE, { profile: null })).toBe('pending');
  });

  it('refuses an unverifiable decline in the last day of the coverage but lets a verified one through', async () => {
    const lastDay = { expiresAt: new Date(Date.now() + 3_600_000) };

    const busy = makeService({ coverage: lastDay });
    await expect(busy.service.decline('claim-1', { reasonCode: WarrantyDeclineReason.BUSY }, TECH))
      .rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
    expect(busy.claimRepo.update).not.toHaveBeenCalled();

    const onLeave = makeService({ coverage: lastDay, profile: { id: 'prof-1', isAvailable: false, workSuspendedUntil: null, serviceRadiusKm: 10 } });
    await onLeave.service.decline('claim-1', { reasonCode: WarrantyDeclineReason.ON_LEAVE }, TECH);
    expect(onLeave.claimRepo.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ declineReview: 'valid' }));
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

  it('moves the inspection time before check-in and tells the customer, but not after', async () => {
    const before = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }) });
    await before.service.reschedule('claim-1', { scheduledAt: FUTURE }, TECH);
    expect(before.visitRepo.update).toHaveBeenCalledWith({ id: 'visit-1', status: WarrantyVisitStatus.SCHEDULED }, { scheduledAt: new Date(FUTURE) });
    expect(before.notifier.toUser).toHaveBeenCalledWith('customer-1', expect.any(String), expect.any(String), 'WARRANTY_VISIT_RESCHEDULED', 'order-1');

    const after = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }), visits: [makeVisit({ status: WarrantyVisitStatus.CHECKED_IN })] });
    await expect(after.service.reschedule('claim-1', { scheduledAt: FUTURE }, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
    await expect(before.service.reschedule('claim-1', { scheduledAt: '2020-01-01T00:00:00.000Z' }, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
  });

  it('needs the faulty part lines for a part fault, and only lines of the original invoice', async () => {
    const claim = makeClaim({ status: WarrantyClaimStatus.ACCEPTED });
    const visits = [makeVisit({ status: WarrantyVisitStatus.CHECKED_IN })];
    const base = { result: WarrantyInspectionResult.COVERED_PART, findings: 'Linh kiện bị nứt ở mối ghép', evidenceRefs: ['photo-1'] };

    const none = makeService({ claim, visits });
    await expect(none.service.propose('claim-1', base, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });

    const stranger = makeService({ claim, visits });
    await expect(stranger.service.propose('claim-1', { ...base, faultyInvoiceItemIds: ['33333333-3333-4333-8333-333333333333'] }, TECH))
      .rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
    expect(stranger.claimTx.update).not.toHaveBeenCalled();

    const labor = makeService({ claim, visits });
    await labor.service.propose('claim-1', { result: WarrantyInspectionResult.COVERED_WORKMANSHIP, findings: 'Mối nối bị lỏng do lắp chưa chặt' }, TECH);
    expect(labor.visitTx.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ faultyInvoiceItemIds: null }));
  });

  it('stores how many of a x3 line are faulty and refuses more than were bought', async () => {
    const claim = makeClaim({ status: WarrantyClaimStatus.ACCEPTED });
    const visits = [makeVisit({ status: WarrantyVisitStatus.CHECKED_IN })];
    const partLines = [{ id: LINE_1, quantity: 3 }];
    const base = { result: WarrantyInspectionResult.COVERED_PART, findings: 'Linh kiện bị nứt ở mối ghép', evidenceRefs: ['photo-1'], faultyInvoiceItemIds: [LINE_1] };
    const ok = makeService({ claim, visits, partLines });
    await ok.service.propose('claim-1', { ...base, faultyQuantities: { [LINE_1]: 1 } }, TECH);
    expect(ok.visitTx.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ faultyQuantities: { [LINE_1]: 1 } }));
    for (const bad of [4, 0, 1.5]) {
      const over = makeService({ claim, visits, partLines });
      await expect(over.service.propose('claim-1', { ...base, faultyQuantities: { [LINE_1]: bad } }, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
    }
  });

  it('proposes a conclusion only after check-in and moves the claim to inspected for manager approval', async () => {
    const early = makeService({ claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }) });
    await expect(
      early.service.propose(
        'claim-1',
        { result: WarrantyInspectionResult.COVERED_PART, findings: 'Linh kiện bị nứt ở mối ghép', evidenceRefs: ['photo-1'], faultyInvoiceItemIds: [LINE_1] },
        TECH,
      ),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });

    const noEvidence = makeService({
      claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }),
      visits: [makeVisit({ status: WarrantyVisitStatus.CHECKED_IN })],
    });
    await expect(
      noEvidence.service.propose('claim-1', { result: WarrantyInspectionResult.COVERED_PART, findings: 'Linh kiện bị nứt ở mối ghép' }, TECH),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
    expect(noEvidence.claimTx.update).not.toHaveBeenCalled();

    const labor = makeService({
      claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }),
      visits: [makeVisit({ status: WarrantyVisitStatus.CHECKED_IN })],
    });
    await labor.service.propose('claim-1', { result: WarrantyInspectionResult.COVERED_WORKMANSHIP, findings: 'Mối nối bị lỏng do lắp chưa chặt' }, TECH);
    expect(labor.claimTx.update).toHaveBeenCalled();

    const ok = makeService({
      claim: makeClaim({ status: WarrantyClaimStatus.ACCEPTED }),
      visits: [makeVisit({ status: WarrantyVisitStatus.CHECKED_IN })],
    });
    await ok.service.propose(
      'claim-1',
      { result: WarrantyInspectionResult.COVERED_PART, findings: 'Linh kiện bị nứt ở mối ghép', evidenceRefs: ['photo-1'], faultyInvoiceItemIds: [LINE_1, LINE_1, LINE_2] },
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
        faultyInvoiceItemIds: [LINE_1, LINE_2],
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

    expect(claimRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { technicianId: TECH.id, status: WarrantyClaimStatus.ACCEPTED }, skip: 0, take: 100 }),
    );
    expect(reader.toStaffViews).toHaveBeenCalled();
    expect(result).toEqual({ items: [{ id: 'claim-1' }], total: 1 });
  });

  it('pages the list when asked (PO 12/10/2026: every table has pages)', async () => {
    const { service, claimRepo } = makeService();

    await service.listMine(TECH, undefined, 3, 20);

    expect(claimRepo.findAndCount).toHaveBeenCalledWith(expect.objectContaining({ where: { technicianId: TECH.id }, skip: 40, take: 20 }));
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
