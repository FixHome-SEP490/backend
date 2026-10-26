import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DataSource, EntityManager, FindOperator } from 'typeorm';
import { Role } from '../../shared/enums';
import { VouchersService } from './vouchers.service';
import { VoucherEvidence, UnavailableVoucherEvidence } from './voucher.ports';
import {
  VoucherAudit,
  VoucherCampaign,
  VoucherClaim,
  VoucherReservation,
} from './entities/voucher.entity';
import {
  APPLY_TTL_MS,
  CheckoutFacts,
  FailureFacts,
  ReservationState,
  SettlementFacts,
  VoucherDiscount,
  VoucherKind,
} from './voucher.types';
import { CreateVoucherCampaignDto } from './dto/voucher.dto';
import { User } from '../users/entities/user.entity';
import { AccountStatus } from '../../shared/enums';

// Behavioral transaction double only. Does NOT simulate PostgreSQL locks/indexes or prove concurrency.
function fixtureStore() {
  const tables = new Map<unknown, Record<string, any>[]>();
  const rows = (type: unknown) => {
    if (!tables.has(type)) tables.set(type, []);
    return tables.get(type)!;
  };
  const matches = (row: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([key, value]) =>
      value instanceof FindOperator && value.type === 'in'
        ? value.value.includes(row[key])
        : row[key] === value,
    );
  const manager = {
    async findOne(type: unknown, options: { where: Record<string, any> }) {
      return rows(type).find((row) => matches(row, options.where)) ?? null;
    },
    async find(type: unknown, options: { where: Record<string, any> }) {
      return rows(type).filter((row) => matches(row, options.where));
    },
    async count(type: unknown, options: { where: Record<string, any> }) {
      return rows(type).filter((row) => matches(row, options.where)).length;
    },
    create(_type: unknown, data: Record<string, any>) {
      return { id: randomUUID(), ...data };
    },
    async save(type: unknown, value: Record<string, any>) {
      const table = rows(type),
        existing = table.findIndex((row) => row.id === value.id);
      if (existing < 0) table.push(value);
      else table[existing] = value;
      return value;
    },
    async query() {
      return [{ now: new Date() }];
    },
  } as unknown as EntityManager;
  const dataSource = {
    async transaction(work: (m: EntityManager) => Promise<unknown>) {
      const before = new Map(
        [...tables].map(([key, value]) => [key, structuredClone(value)]),
      );
      try {
        return await work(manager);
      } catch (error) {
        tables.clear();
        for (const [key, value] of before) tables.set(key, value);
        throw error;
      }
    },
  } as unknown as DataSource;
  return { rows, manager, dataSource };
}

describe('standalone voucher lifecycle (no database concurrency claim)', () => {
  const admin = { id: randomUUID(), role: Role.ADMIN };
  const customer = { id: randomUUID(), role: Role.CUSTOMER };
  const stranger = { id: randomUUID(), role: Role.CUSTOMER };
  let store: ReturnType<typeof fixtureStore>;
  let service: VouchersService;
  let facts: CheckoutFacts;
  let failure: FailureFacts;
  let settlement: SettlementFacts;
  let releasable: boolean;
  let evidence: VoucherEvidence;
  const policy = (kind = VoucherKind.GENERAL): CreateVoucherCampaignDto => ({
    name: 'Ưu đãi thử nghiệm',
    code: 'TEST100',
    kind,
    discount: VoucherDiscount.PERCENT,
    value: 10,
    minimumVnd: 10000,
    capVnd: 50000,
    quota: 100,
    categoryIds: [],
    serviceIds: [],
    startsAt: '2026-10-26T00:00:00Z',
    endsAt: '2026-10-27T00:00:00Z',
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T03:00:00Z'));
    store = fixtureStore();
    releasable = true;
    facts = {
      scopeId: randomUUID(),
      customerId: customer.id,
      snapshotId: randomUUID(),
      finalized: true,
      paymentState: 'NOT_STARTED',
      eligibleSubtotalVnd: 100000,
      items: [{ categoryId: randomUUID(), serviceId: randomUUID() }],
    };
    failure = {
      sourceKind: 'VISIT_GROUP',
      sourceId: randomUUID(),
      customerId: customer.id,
      eligible: true,
      reason: 'REPAIR_FAILED',
    };
    evidence = {
      checkout: async () => facts,
      failure: async () => failure,
      settlement: async () => settlement,
      canRelease: async () => releasable,
    };
    service = new VouchersService(store.dataSource, evidence);
  });
  afterEach(() => vi.useRealTimers());
  async function setup(kind = VoucherKind.GENERAL) {
    const campaign = await service.createCampaign(admin, policy(kind));
    const claim =
      kind === VoucherKind.GENERAL
        ? await service.claim(customer, campaign.code)
        : await service.issueCompensation(campaign.id, randomUUID());
    return { campaign, claim };
  }
  async function reserve() {
    const { campaign, claim } = await setup();
    const dto = {
      claimId: claim.id,
      scopeId: facts.scopeId,
      attemptId: randomUUID(),
    };
    const reservation = await service.apply(customer, dto);
    settlement = {
      settlementId: randomUUID(),
      reservationId: reservation.id,
      customerId: customer.id,
      scopeId: facts.scopeId,
      snapshotId: facts.snapshotId,
      status: 'SETTLED',
      settledAt: new Date(),
    };
    return { campaign, claim, dto, reservation };
  }
  it('lists only claimable GENERAL campaigns for the signed-in customer', async () => {
    const open = await service.createCampaign(admin, policy());
    const claimed = await service.createCampaign(admin, { ...policy(), code: 'CLAIMED' });
    await service.claim(customer, claimed.code);
    await service.createCampaign(admin, { ...policy(VoucherKind.PERSONAL), code: 'PRIVATE' });
    const paused = await service.createCampaign(admin, { ...policy(), code: 'PAUSED' });
    await service.setCampaignActive(admin, paused.id, false);
    await service.createCampaign(admin, { ...policy(), code: 'ENDED', endsAt: '2026-10-26T02:00:00Z' });
    expect(await service.browseGeneral(customer)).toEqual([expect.objectContaining({ id: open.id, code: open.code })]);
    expect((await service.browseGeneral(customer))[0]).not.toHaveProperty('quota');
    expect((await service.browseGeneral(customer))[0]).not.toHaveProperty('sourceKey');
    expect((await service.browseGeneral(stranger)).map(row => row.code)).toContain('CLAIMED');
    await expect(service.browseGeneral(admin)).rejects.toThrow();
  });
  it('grants PERSONAL to a real customer once per admin grant ID without incident evidence', async () => {
    const campaign = await service.createCampaign(admin, policy(VoucherKind.PERSONAL));
    store.rows(User).push({ id: customer.id, role: Role.CUSTOMER, status: AccountStatus.ACTIVE, isActive: true });
    const grantId = randomUUID();
    const first = await service.grantPersonal(admin, campaign.id, { customerId: customer.id, grantId });
    expect((await service.grantPersonal(admin, campaign.id, { customerId: customer.id, grantId })).id).toBe(first.id);
    expect(store.rows(VoucherClaim)).toHaveLength(1);
    expect(store.rows(VoucherClaim)[0].sourceKind).toBe('ADMIN_GRANT');
    expect((await service.wallet(customer))[0].campaign.kind).toBe(VoucherKind.PERSONAL);
    expect(first).not.toHaveProperty('sourceKey');
    expect(first).not.toHaveProperty('customerId');
    await expect(service.grantPersonal(admin, campaign.id, { customerId: stranger.id, grantId })).rejects.toThrow();
    await expect(service.grantPersonal(customer, campaign.id, { customerId: customer.id, grantId: randomUUID() })).rejects.toThrow();
    const other = await service.createCampaign(admin, { ...policy(VoucherKind.PERSONAL), code: 'OTHER' });
    await expect(service.grantPersonal(admin, other.id, { customerId: customer.id, grantId })).rejects.toThrow();
    await expect(service.grantPersonal(admin, campaign.id, { customerId: stranger.id, grantId: randomUUID() })).rejects.toThrow();
  });
  it('issues automatically only from the configured PERSONAL campaign and deduplicates a failed scope', async () => {
    await expect(service.issueAutoCompensation(randomUUID())).rejects.toThrow();
    const configured = await service.createCampaign(admin, { ...policy(VoucherKind.PERSONAL), autoCompensation: true });
    expect(configured.autoCompensation).toBe(true);
    const first = await service.issueAutoCompensation(randomUUID());
    expect((await service.issueAutoCompensation(randomUUID())).id).toBe(first.id);
    await expect(service.createCampaign(admin, { ...policy(VoucherKind.PERSONAL), code: 'SECOND', autoCompensation: true })).rejects.toThrow();
    await service.setCampaignActive(admin, configured.id, false);
    await expect(service.issueAutoCompensation(randomUUID())).rejects.toThrow();
    expect(store.rows(VoucherClaim)).toHaveLength(1);
  });
  it('retries persisted failed incidents from the audit receipt sweep', async () => {
    await service.createCampaign(admin, { ...policy(VoucherKind.PERSONAL), autoCompensation: true });
    const incidentId = randomUUID();
    (store.dataSource as any).manager = store.manager;
    (store.dataSource as any).query = async () => [{ incidentId }];
    const issue = vi.spyOn(service, 'issueAutoCompensation');
    await service.sweepRepairCompensation();
    expect(issue).toHaveBeenCalledWith(incidentId);
    expect(store.rows(VoucherClaim)).toHaveLength(1);
  });
  it('claim is owned, idempotent and uses no redemption quota', async () => {
    const { campaign, claim } = await setup();
    expect((await service.claim(customer, campaign.code)).id).toBe(claim.id);
    expect(store.rows(VoucherClaim)).toHaveLength(1);
    expect(store.rows(VoucherReservation)).toHaveLength(0);
    expect(campaign.redeemed).toBe(0);
    expect(store.rows(VoucherClaim)[0].customerId).toBe(customer.id);
  });
  it('reserves exactly 15 minutes; attempt replay never extends TTL', async () => {
    const { reservation, dto, campaign } = await reserve();
    expect(+reservation.expiresAt - +reservation.reservedAt).toBe(APPLY_TTL_MS);
    vi.advanceTimersByTime(60000);
    expect((await service.apply(customer, dto)).id).toBe(reservation.id);
    expect(campaign.redeemed).toBe(0);
  });
  it('rejects attempt reuse with changed checkout', async () => {
    const { dto } = await reserve();
    await expect(
      service.apply(customer, { ...dto, scopeId: randomUUID() }),
    ).rejects.toThrow();
  });
  it('rejects another owner applying or releasing a wallet voucher', async () => {
    const { dto, reservation } = await reserve();
    await expect(
      service.apply(stranger, { ...dto, attemptId: randomUUID() }),
    ).rejects.toThrow();
    await expect(service.release(stranger, reservation.id)).rejects.toThrow();
  });
  it('requires release before changing checkout; release/retry are idempotent', async () => {
    const { dto, reservation } = await reserve();
    facts = { ...facts, scopeId: randomUUID(), snapshotId: randomUUID() };
    const next = { ...dto, scopeId: facts.scopeId, attemptId: randomUUID() };
    await expect(service.apply(customer, next)).rejects.toThrow();
    await service.release(customer, reservation.id);
    await service.release(customer, reservation.id);
    expect((await service.apply(customer, next)).state).toBe(
      ReservationState.RESERVED,
    );
  });
  it('at the 15-minute boundary expires safely without permanent consumption', async () => {
    const { dto, reservation } = await reserve();
    vi.advanceTimersByTime(APPLY_TTL_MS);
    await service.expireCampaign(reservation.campaignId);
    expect(store.rows(VoucherReservation)[0].state).toBe(
      ReservationState.EXPIRED,
    );
    // Same attempt remains terminal, it never creates a fresh hold.
    expect((await service.apply(customer, dto)).state).toBe(
      ReservationState.EXPIRED,
    );
    expect(
      (await service.apply(customer, { ...dto, attemptId: randomUUID() }))
        .state,
    ).toBe(ReservationState.RESERVED);
  });
  it('does not release overdue or cancelled holds while payment safety is unknown', async () => {
    const { reservation } = await reserve();
    releasable = false;
    vi.advanceTimersByTime(APPLY_TTL_MS);
    await service.expireCampaign(reservation.campaignId);
    expect(store.rows(VoucherReservation)[0].state).toBe(
      ReservationState.RESERVED,
    );
    await expect(service.release(customer, reservation.id)).rejects.toThrow();
    await expect(
      service.redeemSettled(settlement.settlementId),
    ).rejects.toThrow();
  });
  it('only verified settlement consumes quota once, including callback replay', async () => {
    const { reservation } = await reserve();
    await service.redeemSettled(settlement.settlementId);
    await service.redeemSettled(settlement.settlementId);
    expect(store.rows(VoucherCampaign)[0].redeemed).toBe(1);
    expect(store.rows(VoucherClaim)[0].redeemedAt).toEqual(
      settlement.settledAt,
    );
    expect(store.rows(VoucherReservation)[0].state).toBe(
      ReservationState.REDEEMED,
    );
    expect(
      store.rows(VoucherAudit).filter((x) => x.action === 'REDEEM'),
    ).toHaveLength(1);
    await expect(service.release(customer, reservation.id)).rejects.toThrow();
  });
  it.each(['customerId', 'scopeId', 'snapshotId', 'reservationId'] as const)(
    'rejects mismatched settlement %s',
    async (field) => {
      await reserve();
      settlement[field] = randomUUID();
      await expect(
        service.redeemSettled(settlement.settlementId),
      ).rejects.toThrow();
      expect(store.rows(VoucherCampaign)[0].redeemed).toBe(0);
    },
  );
  it('rejects pending, future or late settlements and released reservations', async () => {
    const { reservation } = await reserve();
    settlement.status = 'PENDING' as 'SETTLED';
    await expect(
      service.redeemSettled(settlement.settlementId),
    ).rejects.toThrow();
    settlement.status = 'SETTLED';
    settlement.settledAt = new Date(Date.now() + 1);
    await expect(
      service.redeemSettled(settlement.settlementId),
    ).rejects.toThrow();
    settlement.settledAt = new Date();
    await service.release(customer, reservation.id);
    await expect(
      service.redeemSettled(settlement.settlementId),
    ).rejects.toThrow();
  });
  it('quota capacity includes active holds (sequential policy check, not SQL concurrency)', async () => {
    const { campaign } = await reserve();
    campaign.quota = 1;
    const claim = await service.claim(stranger, campaign.code);
    facts = { ...facts, customerId: stranger.id, scopeId: randomUUID() };
    await expect(
      service.apply(stranger, {
        claimId: claim.id,
        scopeId: facts.scopeId,
        attemptId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(store.rows(VoucherCampaign)[0].redeemed).toBe(0);
  });
  it('issues exactly one PERSONAL per canonical failed group even via different child incident IDs', async () => {
    const { campaign, claim } = await setup(VoucherKind.PERSONAL);
    expect(
      (await service.issueCompensation(campaign.id, randomUUID())).id,
    ).toBe(claim.id);
    expect(store.rows(VoucherClaim)).toHaveLength(1);
    await expect(service.claim(stranger, campaign.code)).rejects.toThrow();
    await expect(
      service.apply(stranger, {
        claimId: claim.id,
        scopeId: facts.scopeId,
        attemptId: randomUUID(),
      }),
    ).rejects.toThrow();
  });
  it('supports solo failure but rejects ineligible cancellation and forged source', async () => {
    const campaign = await service.createCampaign(
      admin,
      policy(VoucherKind.PERSONAL),
    );
    failure = { ...failure, sourceKind: 'SOLO' };
    expect(
      (await service.issueCompensation(campaign.id, randomUUID())).sourceKey,
    ).toBe(`SOLO:${failure.sourceId}`);
    failure = { ...failure, sourceId: randomUUID(), eligible: false as true };
    await expect(
      service.issueCompensation(campaign.id, randomUUID()),
    ).rejects.toThrow();
    failure = undefined;
    await expect(
      service.issueCompensation(campaign.id, randomUUID()),
    ).rejects.toThrow();
  });
  it('rejects forged checkout owner, unfinished invoice, pending payment, minimum and category mismatch', async () => {
    const dto = policy();
    dto.categoryIds = [randomUUID()];
    const campaign = await service.createCampaign(admin, dto),
      claim = await service.claim(customer, campaign.code);
    const apply = () =>
      service.apply(customer, {
        claimId: claim.id,
        scopeId: facts.scopeId,
        attemptId: randomUUID(),
      });
    await expect(apply()).rejects.toThrow();
    facts.items[0].categoryId = dto.categoryIds[0];
    facts.eligibleSubtotalVnd = 1;
    await expect(apply()).rejects.toThrow();
    facts.eligibleSubtotalVnd = 100000;
    facts.customerId = stranger.id;
    await expect(apply()).rejects.toThrow();
    facts.customerId = customer.id;
    facts.finalized = false as true;
    await expect(apply()).rejects.toThrow();
    facts.finalized = true;
    facts.paymentState = 'PENDING' as 'NOT_STARTED';
    await expect(apply()).rejects.toThrow();
  });
  it('validates campaign policy in service and enforces Admin/Customer roles', async () => {
    await expect(service.createCampaign(customer, policy())).rejects.toThrow();
    await expect(
      service.createCampaign(admin, { ...policy(), value: 101 }),
    ).rejects.toThrow();
    await expect(
      service.createCampaign(admin, { ...policy(), endsAt: policy().startsAt }),
    ).rejects.toThrow();
    await expect(
      service.createCampaign(admin, { ...policy(), quota: 0 }),
    ).rejects.toThrow();
    await expect(service.claim(admin, 'TEST100')).rejects.toThrow();
  });
  it('unknown and PERSONAL codes have the same public failure', async () => {
    await setup(VoucherKind.PERSONAL);
    const message = async (code: string) => {
      try {
        await service.claim(stranger, code);
      } catch (e) {
        return e.message;
      }
    };
    expect(await message('MISSING')).toBe(await message('TEST100'));
  });
  it('rejects expired or paused campaigns for fresh claim/apply', async () => {
    const { campaign, claim } = await setup();
    await service.setCampaignActive(admin, campaign.id, false);
    await expect(service.claim(stranger, campaign.code)).rejects.toThrow();
    await expect(
      service.apply(customer, {
        claimId: claim.id,
        scopeId: facts.scopeId,
        attemptId: randomUUID(),
      }),
    ).rejects.toThrow();
    await service.setCampaignActive(admin, campaign.id, true);
    vi.setSystemTime(new Date(policy().endsAt));
    await expect(service.claim(stranger, campaign.code)).rejects.toThrow();
  });
  it('wallet never lists another owner and contains the immutable policy', async () => {
    await setup();
    expect(await service.wallet(stranger)).toEqual([]);
    const wallet = await service.wallet(customer);
    expect(wallet).toHaveLength(1);
    expect(wallet[0].policySnapshot.components).toEqual(['LABOR', 'PARTS']);
    expect(wallet[0].campaign.endsAt).toEqual(new Date(policy().endsAt));
    expect(wallet[0].campaign.kind).toBe(VoucherKind.GENERAL);
  });
  it('default adapters fail closed', async () => {
    const adapter = new UnavailableVoucherEvidence();
    await expect(adapter.checkout(store.manager, customer.id, facts.scopeId)).rejects.toThrow();
    await expect(adapter.failure(store.manager, randomUUID())).rejects.toThrow();
    await expect(adapter.settlement(store.manager, randomUUID())).rejects.toThrow();
    await expect(adapter.canRelease(store.manager, randomUUID())).rejects.toThrow();
  });
  it('persists a composite canonical compensation source from the server adapter', async () => {
    await setup(VoucherKind.PERSONAL);
    const claim = store.rows(VoucherClaim)[0];
    expect(claim.sourceKind).toBe('VISIT_GROUP');
    expect(claim.sourceId).toBe(failure.sourceId);
    expect(claim.campaignKind).toBe(VoucherKind.PERSONAL);
  });
  it('normalizes verified source UUID casing before persisting the canonical source tuple', async () => {
    const campaign = await service.createCampaign(
      admin,
      policy(VoucherKind.PERSONAL),
    );
    failure = {
      ...failure,
      sourceId: failure.sourceId.toUpperCase(),
      customerId: customer.id.toUpperCase(),
    };
    const issued = await service.issueCompensation(campaign.id, randomUUID());
    expect(issued.sourceId).toBe(failure.sourceId.toLowerCase());
    expect(issued.sourceKey).toBe(
      `VISIT_GROUP:${failure.sourceId.toLowerCase()}`,
    );
    expect(issued.customerId).toBe(customer.id);
  });
  it('handles internal failed incident events through authoritative evidence without trusting event source data', async () => {
    const campaign = await service.createCampaign(
      admin,
      policy(VoucherKind.PERSONAL),
    );
    const event = {
      type: 'REPAIR_FAILURE_ELIGIBLE_V1' as const,
      incidentId: randomUUID(),
    };
    const first = await service.handleRepairFailure(campaign.id, event);
    const retry = await service.handleRepairFailure(campaign.id, {
      ...event,
      incidentId: randomUUID(),
    });
    expect(first.id).toBe(retry.id);
    expect(first.sourceId).toBe(failure.sourceId);
    await expect(
      service.handleRepairFailure(campaign.id, {
        ...event,
        type: 'CANCELLED' as any,
      }),
    ).rejects.toThrow();
    await expect(
      service.createCampaign(
        { id: randomUUID(), role: Role.SERVICE_MANAGER },
        policy(),
      ),
    ).rejects.toThrow();
  });
  it('serializes only safe customer fields for wallet, claim, apply, release and retries', async () => {
    const { campaign, claim } = await setup();
    const storedClaim = store.rows(VoucherClaim)[0];
    storedClaim.sourceKey = 'VISIT_GROUP:private-source';
    storedClaim.providerId = 'private-provider';
    storedClaim.policySnapshot.internalFunding = 'private-funding';
    store.rows(VoucherCampaign)[0].providerId = 'private-provider';
    const assertSafe = (value: unknown) => {
      const json = JSON.stringify(value);
      for (const field of [
        'sourceKey',
        'customerId',
        'settlementId',
        'checkoutSnapshot',
        'providerId',
        'internalFunding',
        'createdAt',
        'updatedAt',
        'quota',
        'redeemed',
      ]) {
        expect(json).not.toContain(`"${field}":`);
      }
      expect(json).not.toContain('private-');
    };
    assertSafe(claim);
    const claimedAgain = await service.claim(customer, campaign.code);
    const wallet = await service.wallet(customer);
    assertSafe(claimedAgain);
    assertSafe(wallet);
    expect(claimedAgain.id).toBe(claim.id);
    expect(wallet[0].campaign.endsAt).toEqual(campaign.endsAt);
    const dto = {
      claimId: claim.id,
      scopeId: facts.scopeId,
      attemptId: randomUUID(),
    };
    const applied = await service.apply(customer, dto);
    assertSafe(applied);
    expect(applied.expiresAt).toEqual(new Date(Date.now() + APPLY_TTL_MS));
    const storedReservation = store.rows(VoucherReservation)[0];
    storedReservation.settlementId = 'private-settlement';
    storedReservation.providerId = 'private-provider';
    storedReservation.checkoutSnapshot.providerId = 'private-provider';
    assertSafe(await service.apply(customer, dto));
    const released = await service.release(customer, applied.id);
    expect(released.state).toBe(ReservationState.RELEASED);
    assertSafe(released);
    assertSafe(await service.release(customer, applied.id));
    // Projection must not delete the entity data needed by internal adapters.
    expect(store.rows(VoucherClaim)[0].sourceKey).toBe(
      'VISIT_GROUP:private-source',
    );
    expect(storedReservation.checkoutSnapshot.snapshotId).toBe(
      facts.snapshotId,
    );
    expect(storedReservation.settlementId).toBe('private-settlement');
  });
  it('keeps internal PERSONAL source and settlement evidence out of redeemed customer responses', async () => {
    const { campaign } = await setup(VoucherKind.PERSONAL);
    const claim = store.rows(VoucherClaim)[0];
    const dto = {
      claimId: claim.id,
      scopeId: facts.scopeId,
      attemptId: randomUUID(),
    };
    const applied = await service.apply(customer, dto);
    settlement = {
      settlementId: randomUUID(),
      reservationId: applied.id,
      customerId: customer.id,
      scopeId: facts.scopeId,
      snapshotId: facts.snapshotId,
      status: 'SETTLED',
      settledAt: new Date(),
    };
    const internal = await service.redeemSettled(settlement.settlementId);
    expect(internal.settlementId).toBe(settlement.settlementId);
    expect(internal.checkoutSnapshot.snapshotId).toBe(facts.snapshotId);
    const wallet = await service.wallet(customer);
    expect(wallet[0].status).toBe('REDEEMED');
    expect(wallet[0].campaign.kind).toBe(VoucherKind.PERSONAL);
    const replay = await service.apply(customer, dto);
    expect(replay.state).toBe(ReservationState.REDEEMED);
    const serialized = JSON.stringify({ wallet, replay });
    for (const secret of [
      claim.sourceKey,
      settlement.settlementId,
      facts.snapshotId,
      customer.id,
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('checkoutSnapshot');
    expect(serialized).not.toContain('sourceKey');
    expect(serialized).not.toContain('redeemed":');
    expect(
      store.rows(VoucherCampaign).find((row) => row.id === campaign.id)
        .redeemed,
    ).toBe(1);
  });
  it('stores fixed/capped policy snapshots without sharing input references or computing money', async () => {
    const input = {
      ...policy(),
      discount: VoucherDiscount.FIXED,
      value: 20000,
      categoryIds: [facts.items[0].categoryId],
    };
    const campaign = await service.createCampaign(admin, input);
    const claim = await service.claim(customer, campaign.code);
    input.categoryIds.length = 0;
    campaign.policy.value = 99999;
    const reservation = await service.apply(customer, {
      claimId: claim.id,
      scopeId: facts.scopeId,
      attemptId: randomUUID(),
    });
    expect(reservation.policySnapshot.value).toBe(20000);
    expect(reservation.policySnapshot.capVnd).toBe(50000);
    expect(reservation.policySnapshot.categoryIds).toEqual([
      facts.items[0].categoryId,
    ]);
    expect(reservation).not.toHaveProperty('customerDue');
  });
  it('one customer can receive compensation for two distinct eligible visits', async () => {
    const { campaign, claim } = await setup(VoucherKind.PERSONAL);
    failure = { ...failure, sourceId: randomUUID() };
    const second = await service.issueCompensation(campaign.id, randomUUID());
    expect(second.id).not.toBe(claim.id);
    expect(store.rows(VoucherClaim)).toHaveLength(2);
  });
  it('does not reissue a failed visit under another campaign', async () => {
    await setup(VoucherKind.PERSONAL);
    const other = await service.createCampaign(admin, {
      ...policy(VoucherKind.PERSONAL),
      code: 'OTHER',
    });
    await expect(
      service.issueCompensation(other.id, randomUUID()),
    ).rejects.toThrow();
    expect(store.rows(VoucherClaim)).toHaveLength(1);
  });
  it('prevents GENERAL reuse after settlement and a second voucher on a live checkout', async () => {
    const { claim, dto } = await reserve();
    const other = await service.createCampaign(admin, {
      ...policy(),
      code: 'OTHER',
    });
    const otherClaim = await service.claim(customer, other.code);
    await expect(
      service.apply(customer, {
        ...dto,
        claimId: otherClaim.id,
        attemptId: randomUUID(),
      }),
    ).rejects.toThrow();
    await service.redeemSettled(settlement.settlementId);
    await expect(
      service.apply(customer, {
        claimId: claim.id,
        scopeId: randomUUID(),
        attemptId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(store.rows(VoucherCampaign)[0].redeemed).toBe(1);
  });
  it('fails closed for service scope mismatch and malformed checkout facts', async () => {
    const campaign = await service.createCampaign(admin, {
      ...policy(),
      serviceIds: [randomUUID()],
    });
    const claim = await service.claim(customer, campaign.code);
    const dto = {
      claimId: claim.id,
      scopeId: facts.scopeId,
      attemptId: randomUUID(),
    };
    await expect(service.apply(customer, dto)).rejects.toThrow();
    facts = undefined;
    await expect(service.apply(customer, dto)).rejects.toThrow();
    expect(store.rows(VoucherReservation)).toHaveLength(0);
  });
  it('rolls back reservation and redemption changes when durable audit insert fails', async () => {
    const { dto } = await reserve();
    const save = store.manager.save.bind(store.manager);
    vi.spyOn(store.manager, 'save').mockImplementation(
      async (type: any, row: any) => {
        if (type === VoucherAudit) throw new Error('audit unavailable');
        return save(type, row);
      },
    );
    await expect(
      service.redeemSettled(settlement.settlementId),
    ).rejects.toThrow('audit unavailable');
    expect(store.rows(VoucherCampaign)[0].redeemed).toBe(0);
    expect(store.rows(VoucherReservation)[0].state).toBe(
      ReservationState.RESERVED,
    );
    expect(store.rows(VoucherClaim)[0].redeemedAt).toBeNull();
    await expect(
      service.release(customer, store.rows(VoucherReservation)[0].id),
    ).rejects.toThrow('audit unavailable');
    expect((await service.apply(customer, dto)).state).toBe(
      ReservationState.RESERVED,
    );
  });
});
