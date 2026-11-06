import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  FulfillmentMethod,
  PartRequestStatus,
  PartRequestType,
  PartSource,
  PartUsageStatus,
  Role,
  ServiceOrderStatus,
  WarrantyClaimStatus,
} from '../../shared/enums';
import { PartRequestsService } from './part-requests.service';
import { holderPartRequests } from './part-request-lifecycle';
import { WarehouseFulfillmentService } from './warehouse-fulfillment.service';

const TECH = { id: 'tech-1', role: Role.TECHNICIAN };
const SM = { id: 'sm-1', role: Role.SERVICE_MANAGER };

/**
 * A warranty request lives on an order that is already COMPLETED and is used without a quotation,
 * so it must not go through the order-bound rules of the other request types.
 */
const make = (options: { claimStatus?: WarrantyClaimStatus; requestStatus?: PartRequestStatus; claimTechnician?: string | null; part?: unknown; charge?: boolean; warehouse?: WarehouseFulfillmentService } = {}) => {
  const claim = {
    id: 'claim-1', serviceOrderId: 'order-1',
    technicianId: 'claimTechnician' in options ? options.claimTechnician : TECH.id,
    status: options.claimStatus ?? WarrantyClaimStatus.IN_PROGRESS,
  };
  const item: any = {
    id: 'it-1', partRequestId: 'pr-1', partCatalogId: 'part-9', partSource: PartSource.FIXHOME,
    usageStatus: PartUsageStatus.PENDING, quantity: 1, unitPriceSnapshot: 400_000,
  };
  const request: any = {
    id: 'pr-1', serviceOrderId: 'order-1', technicianId: TECH.id, requestType: PartRequestType.WARRANTY,
    warrantyClaimId: 'claim-1', chargeTechnician: options.charge ?? true, status: options.requestStatus ?? PartRequestStatus.READY,
    fulfillmentMethod: FulfillmentMethod.PICKUP, qrToken: 'tok', qrGeneratedAt: new Date(), items: [],
  };
  const order = { id: 'order-1', status: ServiceOrderStatus.COMPLETED, completionRequestedAt: new Date() };
  const manager: any = {
    findOne: vi.fn(async (entity: { name: string }) =>
      entity.name === 'PartRequest' ? request
        : entity.name === 'PartRequestItem' ? item
          : entity.name === 'FixHomePart' ? ('part' in options ? options.part : { id: 'part-9', name: 'Bo mạch', sellingPrice: '400000' })
            : null),
    findOneOrFail: vi.fn(async (entity: { name: string }) => (entity.name === 'ServiceOrder' ? order : request)),
    findOneBy: vi.fn(async (entity: { name: string }) => (entity.name === 'WarrantyClaim' ? claim : null)),
    find: vi.fn(async () => [item]),
    save: vi.fn(async (_entity: unknown, value: unknown) => value),
    create: vi.fn((_entity: unknown, value: object) => ({ id: 'pr-new', ...value })),
  };
  const cost = {
    startReturnClock: vi.fn().mockResolvedValue(undefined), chargeForInstallation: vi.fn().mockResolvedValue(undefined),
    refundUnreturned: vi.fn().mockResolvedValue(undefined), creditReturned: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { logWithManager: vi.fn().mockResolvedValue(undefined) };
  const service = new PartRequestsService(
    { transaction: vi.fn((cb: any) => cb(manager)) } as any, {} as any, {} as any, {} as any,
    audit as any, { createNotification: vi.fn().mockResolvedValue({}) } as any, undefined,
    { get: vi.fn(() => cost) } as any,
    options.warehouse,
  );
  return { service, manager, claim, item, request, cost, audit };
};

describe('createWarrantyRequest', () => {
  it('keeps W2 commands out of Warranty on a completed order while preserving ModuleRef receive clock', async () => {
    const warehouse = new WarehouseFulfillmentService();
    const reserve = vi.spyOn(warehouse, 'reserve');
    for (const kind of ['reserve', 'qr', 'handover'] as const) {
      const f = make({ warehouse });
      await expect(f.service.warehouseCommand('pr-1', kind, { idempotencyKey: 'command-key' }, SM))
        .rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
    }
    expect(reserve).not.toHaveBeenCalled();
    const f = make({ warehouse });
    await f.service.receiveByQr('pr-1', { qrToken: 'tok' }, TECH);
    expect(f.cost.startReturnClock).toHaveBeenCalledOnce();
  });
  it('opens a request tied to the claim at the selling price; nobody is charged until the faulty part is inspected', async () => {
    const { service, manager, claim } = make();

    const request = await service.createWarrantyRequest(manager, {
      claim: claim as any, items: [{ partCatalogId: 'part-9', quantity: 1 }, { partCatalogId: 'part-9', quantity: 2 }], actor: SM,
    });

    expect(request).toMatchObject({
      requestType: PartRequestType.WARRANTY, warrantyClaimId: 'claim-1', technicianId: TECH.id,
      chargeTechnician: false, status: PartRequestStatus.REQUESTED, shippingFee: 0,
    });
    const rows = manager.save.mock.calls.find((call: any[]) => call[0].name === 'PartRequestItem')![1];
    expect(rows).toEqual([expect.objectContaining({
      partCatalogId: 'part-9', partSource: PartSource.FIXHOME, partNameSnapshot: 'Bo mạch', quantity: 3, unitPriceSnapshot: 400_000, partRequestId: 'pr-new',
    })]);
  });

  it('refuses a claim without a technician, an empty or bad list, an inactive part and a second request', async () => {
    const base = { actor: SM };
    const nobody = make({ claimTechnician: null });
    await expect(nobody.service.createWarrantyRequest(nobody.manager, { ...base, claim: nobody.claim as any, items: [{ partCatalogId: 'part-9', quantity: 1 }] }))
      .rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });

    const empty = make();
    await expect(empty.service.createWarrantyRequest(empty.manager, { ...base, claim: empty.claim as any, items: [] }))
      .rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });

    for (const quantity of [0, 1.5, 101]) {
      const bad = make();
      await expect(bad.service.createWarrantyRequest(bad.manager, { ...base, claim: bad.claim as any, items: [{ partCatalogId: 'part-9', quantity }] }))
        .rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
    }

    const inactive = make({ part: null });
    await expect(inactive.service.createWarrantyRequest(inactive.manager, { ...base, claim: inactive.claim as any, items: [{ partCatalogId: 'part-9', quantity: 1 }] }))
      .rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });

    const twice = make();
    twice.manager.findOneBy.mockResolvedValueOnce({ id: 'pr-existing' });
    await expect(twice.service.createWarrantyRequest(twice.manager, { ...base, claim: twice.claim as any, items: [{ partCatalogId: 'part-9', quantity: 1 }] }))
      .rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
  });
});

describe('bringing the faulty part back and inspecting it', () => {
  const dto = (overrides: Record<string, unknown> = {}) => ({ result: 'manufacturer', ...overrides }) as any;
  const installation = { result: 'installation', note: 'Đấu sai cực dây nguồn, chân cắm cháy.', evidenceRefs: ['photo-1'] };
  const returned = (f: ReturnType<typeof make>) => { f.request.faultyReturnedAt = new Date(); return f; };

  it('hands over the replacement without waiting for the faulty part: the manager does not inspect first', async () => {
    const f = make({ requestStatus: PartRequestStatus.REQUESTED });

    await f.service.markReady('pr-1', SM);

    expect(f.request.status).toBe(PartRequestStatus.READY);
    expect(f.request.qrToken).toBeTruthy();
  });

  it('lets the technician report the faulty part back once the replacement is received; a repeat keeps the first record', async () => {
    const f = make({ requestStatus: PartRequestStatus.RECEIVED });

    const first = await f.service.returnFaultyPart('pr-1', { note: ' Đã giao kho ', evidenceRefs: ['p1'] }, TECH);
    const at = first.faultyReturnedAt;
    await f.service.returnFaultyPart('pr-1', { note: 'khác' }, TECH);

    expect(f.request).toMatchObject({ faultyReturnNote: 'Đã giao kho', faultyReturnEvidence: ['p1'] });
    expect(f.request.faultyReturnedAt).toBe(at);
    expect(f.audit.logWithManager).toHaveBeenCalledTimes(1);
  });

  it('refuses the return before the replacement was received, from another technician, a manager, and a non-warranty request', async () => {
    const early = make({ requestStatus: PartRequestStatus.READY });
    await expect(early.service.returnFaultyPart('pr-1', {}, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });

    const other = make({ requestStatus: PartRequestStatus.RECEIVED });
    await expect(other.service.returnFaultyPart('pr-1', {}, { id: 'tech-2', role: Role.TECHNICIAN })).rejects.toThrow(/access denied/);
    await expect(other.service.returnFaultyPart('pr-1', {}, SM)).rejects.toThrow(/Technician role/);

    const ordinary = make({ requestStatus: PartRequestStatus.RECEIVED });
    ordinary.request.requestType = PartRequestType.ADDITIONAL;
    await expect(ordinary.service.returnFaultyPart('pr-1', {}, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
  });

  it('still works after the claim closed: the part outlives the claim', async () => {
    const f = make({ requestStatus: PartRequestStatus.COMPLETED, claimStatus: WarrantyClaimStatus.RESOLVED });

    await expect(f.service.returnFaultyPart('pr-1', {}, TECH)).resolves.toMatchObject({ faultyReturnedAt: expect.any(Date) });
  });

  it('inspects only after the faulty part is back', async () => {
    const f = make({ requestStatus: PartRequestStatus.RECEIVED });

    await expect(f.service.recordFaultyInspection('pr-1', dto(), SM)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
    expect(f.request.faultyInspectionResult).toBeUndefined();
  });

  it('decides who pays: installation is the technician, manufacturer and undetermined are FixHome', async () => {
    for (const [result, charged] of [['installation', true], ['manufacturer', false], ['undetermined', false]] as const) {
      const f = returned(make({ requestStatus: PartRequestStatus.RECEIVED, charge: !charged }));
      await f.service.recordFaultyInspection('pr-1', result === 'installation' ? installation as any : dto({ result }), SM);
      expect(f.request).toMatchObject({ faultyInspectionResult: result, chargeTechnician: charged, faultyInspectedBy: SM.id });
      expect(f.cost.chargeForInstallation).toHaveBeenCalledWith(expect.anything(), f.request);
      expect(f.cost.refundUnreturned).toHaveBeenCalledWith(expect.anything(), f.request);
      expect(f.audit.logWithManager).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'WARRANTY_FAULTY_PART_INSPECTED' }));
    }
  });

  it('refuses an installation verdict without a written reason and a photo, and bad input', async () => {
    for (const bad of [{ result: 'installation' }, { ...installation, note: 'ngắn' }, { ...installation, evidenceRefs: [] }]) {
      const f = returned(make({ requestStatus: PartRequestStatus.RECEIVED }));
      await expect(f.service.recordFaultyInspection('pr-1', bad as any, SM)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
      expect(f.request.faultyInspectionResult).toBeUndefined();
    }
  });

  it('records the result once: it moves money, so a change goes through a support case', async () => {
    const f = returned(make({ requestStatus: PartRequestStatus.RECEIVED }));
    await f.service.recordFaultyInspection('pr-1', dto(), SM);

    await expect(f.service.recordFaultyInspection('pr-1', installation as any, SM)).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
    expect(f.request.faultyInspectionResult).toBe('manufacturer');
  });

  it('is for service managers and warranty requests only', async () => {
    const tech = returned(make({ requestStatus: PartRequestStatus.RECEIVED }));
    await expect(tech.service.recordFaultyInspection('pr-1', dto(), TECH)).rejects.toThrow(/Service Manager/);

    const ordinary = returned(make({ requestStatus: PartRequestStatus.RECEIVED }));
    ordinary.request.requestType = PartRequestType.ADDITIONAL;
    await expect(ordinary.service.recordFaultyInspection('pr-1', dto(), SM)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
  });
});

describe('handover and use of a warranty part after the order completed', () => {
  it('lets the claim technician scan the QR on a completed order, which starts the faulty-part deadline and charges nothing yet', async () => {
    const { service, request, cost } = make();

    const saved = await service.receiveByQr('pr-1', { qrToken: 'tok' } as any, TECH);

    expect(saved.status).toBe(PartRequestStatus.RECEIVED);
    expect(cost.startReturnClock).toHaveBeenCalledWith(expect.anything(), request);
    expect(cost.chargeForInstallation).not.toHaveBeenCalled();
  });

  it('refuses another technician, a customer and a closed claim', async () => {
    const other = make();
    await expect(other.service.receiveByQr('pr-1', { qrToken: 'tok' } as any, { id: 'tech-2', role: Role.TECHNICIAN })).rejects.toThrow(/access denied/i);
    expect(other.cost.startReturnClock).not.toHaveBeenCalled();

    const closed = make({ claimStatus: WarrantyClaimStatus.RESOLVED });
    await expect(closed.service.receiveByQr('pr-1', { qrToken: 'tok' } as any, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.ORDER_INVALID_TRANSITION } });
    expect(closed.cost.startReturnClock).not.toHaveBeenCalled();

    const wrongToken = make();
    await expect(wrongToken.service.receiveByQr('pr-1', { qrToken: 'nope' } as any, TECH)).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
  });

  it('records USED or RETURNED once, without a quotation or a repair in progress, and credits a returned part', async () => {
    const used = make({ requestStatus: PartRequestStatus.RECEIVED });
    await used.service.updateItemUsage('pr-1', 'it-1', { usageStatus: PartUsageStatus.USED } as any, TECH);
    expect(used.item.usageStatus).toBe(PartUsageStatus.USED);

    const returned = make({ requestStatus: PartRequestStatus.RECEIVED });
    await returned.service.updateItemUsage('pr-1', 'it-1', { usageStatus: PartUsageStatus.RETURNED } as any, TECH);
    expect(returned.cost.creditReturned).toHaveBeenCalledWith(expect.anything(), returned.request, expect.objectContaining({ usageStatus: PartUsageStatus.RETURNED }));

    const again = make({ requestStatus: PartRequestStatus.RECEIVED });
    again.item.usageStatus = PartUsageStatus.USED;
    await expect(again.service.updateItemUsage('pr-1', 'it-1', { usageStatus: PartUsageStatus.RETURNED } as any, TECH))
      .rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
  });
});

describe('settleWarrantyRequest', () => {
  it('completes a received request and cancels one never handed over', async () => {
    const received = make({ requestStatus: PartRequestStatus.RECEIVED });
    await received.service.settleWarrantyRequest(received.manager, 'claim-1');
    expect(received.request).toMatchObject({ status: PartRequestStatus.COMPLETED, qrToken: null, completedAt: expect.any(Date) });

    const waiting = make({ requestStatus: PartRequestStatus.READY });
    await waiting.service.settleWarrantyRequest(waiting.manager, 'claim-1');
    expect(waiting.request).toMatchObject({ status: PartRequestStatus.CANCELLED, qrToken: null, cancelledAt: expect.any(Date) });
  });

  it('leaves a finished request and a claim without one alone', async () => {
    const done = make({ requestStatus: PartRequestStatus.COMPLETED });
    await done.service.settleWarrantyRequest(done.manager, 'claim-1');
    expect(done.manager.save).not.toHaveBeenCalled();

    const none = make();
    none.manager.findOne.mockResolvedValueOnce(null);
    await none.service.settleWarrantyRequest(none.manager, 'claim-1');
    expect(none.manager.save).not.toHaveBeenCalled();
  });
});

describe('the original order never sees a warranty request', () => {
  it('keeps it out of the requests that gate completion', async () => {
    const warranty: any = { id: 'w', requestType: PartRequestType.WARRANTY, technicianId: TECH.id, status: PartRequestStatus.READY, items: [] };
    const ordinary: any = { id: 'o', requestType: PartRequestType.QUOTATION, technicianId: TECH.id, status: PartRequestStatus.RECEIVED, items: [] };
    const manager: any = { findOneBy: vi.fn().mockResolvedValue({ technicianId: TECH.id }) };

    expect(await holderPartRequests(manager, 'order-1', [warranty, ordinary])).toEqual([ordinary]);
  });
});
