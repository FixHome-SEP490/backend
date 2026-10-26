import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { isUUID, validateSync } from 'class-validator';
import { DataSource, EntityManager, In } from 'typeorm';
import { AccountStatus, Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { startBackgroundJob } from '../../common/background-job';
import { REPAIR_FAILURE_ACTION } from '../service-orders/repair-failure-incident';
import { VoucherEvidence } from './voucher.ports';
import {
  APPLY_TTL_MS,
  CheckoutFacts,
  ReservationState,
  VoucherActor,
  VoucherDiscount,
  VoucherKind,
  RepairFailureVoucherEvent,
} from './voucher.types';
import { ApplyVoucherDto, CreateVoucherCampaignDto, GrantPersonalVoucherDto } from './dto/voucher.dto';
import {
  CustomerVoucherClaimDto,
  CustomerGeneralVoucherDto,
  CustomerVoucherReservationDto,
  customerClaim,
  customerGeneralVoucher,
  customerReservation,
} from './dto/customer-voucher-response.dto';
import {
  VoucherAudit,
  VoucherCampaign,
  VoucherClaim,
  VoucherReservation,
} from './entities/voucher.entity';

@Injectable()
export class VouchersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VouchersService.name);
  private compensationTimer: NodeJS.Timeout | null = null;
  onModuleInit(): void {
    this.compensationTimer = startBackgroundJob('repair compensation sweep', this.logger, () => this.sweepRepairCompensation());
  }
  onModuleDestroy(): void {
    if (this.compensationTimer) clearInterval(this.compensationTimer);
  }
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(VoucherEvidence) private readonly evidence: VoucherEvidence,
  ) {}

  async createCampaign(
    actor: VoucherActor,
    dto: CreateVoucherCampaignDto,
  ): Promise<VoucherCampaign> {
    this.role(actor, Role.ADMIN);
    const input = plainToInstance(CreateVoucherCampaignDto, dto);
    if (
      validateSync(input, { whitelist: true, forbidNonWhitelisted: true })
        .length ||
      !input.name.trim() ||
      (input.autoCompensation === true && input.kind !== VoucherKind.PERSONAL) ||
      (input.discount === VoucherDiscount.PERCENT && input.value > 100) ||
      +new Date(input.endsAt) <= +new Date(input.startsAt)
    ) {
      throw new BadRequestException(
        'Thông tin chương trình ưu đãi không hợp lệ.',
      );
    }
    return this.transaction(async (manager) => {
      if (input.autoCompensation && await manager.findOne(VoucherCampaign, { where: { autoCompensation: true, active: true } }))
        this.conflict();
      const campaign = await manager.save(
        VoucherCampaign,
        manager.create(VoucherCampaign, {
          code: input.code,
          name: input.name.trim(),
          kind: input.kind,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          active: true,
          autoCompensation: input.autoCompensation === true,
          quota: input.quota,
          redeemed: 0,
          policy: {
            discount: input.discount,
            value: input.value,
            capVnd: input.capVnd ?? null,
            minimumVnd: input.minimumVnd,
            categoryIds: [...input.categoryIds],
            serviceIds: [...input.serviceIds],
            components: ['LABOR', 'PARTS'],
          },
        }),
      );
      await this.audit(manager, actor.id, 'CREATE_CAMPAIGN', campaign.id, {
        policy: campaign.policy,
        quota: campaign.quota,
      });
      return campaign;
    });
  }

  async setCampaignActive(
    actor: VoucherActor,
    campaignId: string,
    active: boolean,
  ): Promise<VoucherCampaign> {
    this.role(actor, Role.ADMIN);
    if (typeof active !== 'boolean')
      throw new BadRequestException('Trạng thái không hợp lệ.');
    return this.transaction(async (manager) => {
      const campaign = await this.lockCampaign(manager, campaignId);
      if (campaign.active !== active) {
        campaign.active = active;
        await manager.save(VoucherCampaign, campaign);
        await this.audit(
          manager,
          actor.id,
          'SET_CAMPAIGN_ACTIVE',
          campaign.id,
          { active },
        );
      }
      return campaign;
    });
  }

  async listCampaigns(actor: VoucherActor): Promise<VoucherCampaign[]> {
    this.role(actor, Role.ADMIN);
    return this.transaction((manager) =>
      manager.find(VoucherCampaign, {
        where: {},
        order: { createdAt: 'DESC' },
        take: 100,
      }),
    );
  }

  async wallet(actor: VoucherActor): Promise<CustomerVoucherClaimDto[]> {
    this.role(actor, Role.CUSTOMER);
    return this.transaction(async (manager) => {
      const claims = await manager.find(VoucherClaim, {
        where: { customerId: actor.id },
        order: { createdAt: 'DESC' },
        take: 100,
      });
      if (!claims.length) return [];
      const campaigns = await manager.find(VoucherCampaign, {
        where: {
          id: In([...new Set(claims.map((claim) => claim.campaignId))]),
        },
      });
      const byId = new Map(
        campaigns.map((campaign) => [campaign.id, campaign]),
      );
      return claims.map((claim) => {
        const campaign = byId.get(claim.campaignId);
        if (!campaign) this.unavailable();
        return customerClaim(claim, campaign);
      });
    });
  }

  async browseGeneral(actor: VoucherActor): Promise<CustomerGeneralVoucherDto[]> {
    this.role(actor, Role.CUSTOMER);
    return this.transaction(async (manager) => {
      const now = await this.now(manager);
      const campaigns = await manager.find(VoucherCampaign, {
        where: { kind: VoucherKind.GENERAL, active: true },
        order: { createdAt: 'DESC' },
      });
      const claims = await manager.find(VoucherClaim, { where: { customerId: actor.id } });
      const claimed = new Set(claims.map((claim) => claim.campaignId));
      return campaigns
        .filter((campaign) => !claimed.has(campaign.id) && +campaign.startsAt <= +now && +now < +campaign.endsAt)
        .slice(0, 100)
        .map(customerGeneralVoucher);
    });
  }

  async grantPersonal(
    actor: VoucherActor,
    campaignId: string,
    dto: GrantPersonalVoucherDto,
  ): Promise<CustomerVoucherClaimDto> {
    this.role(actor, Role.ADMIN);
    if (!dto || !isUUID(dto.customerId, '4') || !isUUID(dto.grantId, '4'))
      throw new BadRequestException('Mã cấp ưu đãi không hợp lệ.');
    return this.transaction(async (manager) => {
      const campaign = await this.lockCampaign(manager, campaignId);
      if (campaign.kind !== VoucherKind.PERSONAL) this.unavailable();
      const customerId = dto.customerId.toLowerCase();
      const grantId = dto.grantId.toLowerCase();
      const existing = await manager.findOne(VoucherClaim, {
        where: { sourceKind: 'ADMIN_GRANT', sourceId: grantId },
      });
      if (existing) {
        if (existing.campaignId !== campaign.id || existing.customerId !== customerId) this.conflict();
        return customerClaim(existing, campaign);
      }
      this.available(campaign, await this.now(manager));
      const customer = await manager.findOne(User, {
        where: { id: customerId, role: Role.CUSTOMER, status: AccountStatus.ACTIVE, isActive: true },
      });
      if (!customer) throw new NotFoundException('Không tìm thấy khách hàng đủ điều kiện.');
      const claim = await this.newClaim(manager, campaign, customerId, `ADMIN_GRANT:${grantId}`, actor.id);
      return customerClaim(claim, campaign);
    });
  }

  async claim(
    actor: VoucherActor,
    code: string,
  ): Promise<CustomerVoucherClaimDto> {
    this.role(actor, Role.CUSTOMER);
    if (typeof code !== 'string' || !/^[A-Z0-9_-]{3,40}$/.test(code))
      this.unavailable();
    return this.transaction(async (manager) => {
      // No public PERSONAL lookup: guessed codes and nonexistent codes have identical errors.
      const campaign = await manager.findOne(VoucherCampaign, {
        where: { code, kind: VoucherKind.GENERAL },
        lock: { mode: 'pessimistic_write' },
      });
      if (!campaign) this.unavailable();
      this.available(campaign, await this.now(manager));
      const existing = await manager.findOne(VoucherClaim, {
        where: { campaignId: campaign.id, customerId: actor.id },
      });
      const claim =
        existing ??
        (await this.newClaim(manager, campaign, actor.id, null, actor.id));
      return customerClaim(claim, campaign);
    });
  }

  /** Internal repair-incident hook. Never exposed as a customer endpoint.
   * Adapter resolves ownership/eligibility and canonical group/solo identity from persisted evidence. */
  async handleRepairFailure(
    campaignId: string,
    event: RepairFailureVoucherEvent,
  ): Promise<VoucherClaim> {
    if (!event || event.type !== 'REPAIR_FAILURE_ELIGIBLE_V1')
      throw new BadRequestException('Thông tin sự cố không hợp lệ.');
    return this.issueCompensation(campaignId, event.incidentId);
  }

  /** Called after the repair transaction commits and by the catch-up sweep. */
  async issueAutoCompensation(incidentId: string): Promise<VoucherClaim> {
    this.uuid(incidentId);
    const campaign = await this.transaction(async (manager) =>
      manager.findOne(VoucherCampaign, { where: { kind: VoucherKind.PERSONAL, autoCompensation: true, active: true } }),
    );
    if (!campaign) throw new ServiceUnavailableException('Chưa cấu hình chương trình bù sửa chữa cho quản trị viên.');
    return this.issueCompensation(campaign.id, incidentId);
  }

  /** The strict repair audit receipt is the durable catch-up source after a failed dispatch. */
  async sweepRepairCompensation(): Promise<void> {
    const campaign = await this.dataSource.manager.findOne(VoucherCampaign, {
      where: { kind: VoucherKind.PERSONAL, autoCompensation: true, active: true },
    });
    if (!campaign) {
      this.logger.warn('Admin configuration missing: active PERSONAL autoCompensation campaign');
      return;
    }
    const incidents: { incidentId: string }[] = await this.dataSource.query(`
      SELECT DISTINCT ON (COALESCE(b.visit_group_id, o.id)) a.after->>'incidentId' AS "incidentId"
      FROM audit_logs a
      JOIN service_orders o ON o.id::text = a.resource_id
      JOIN bookings b ON b.id = o.booking_id
      WHERE a.action = $1 AND a.resource_type = 'service_order' AND a.created_at >= $2
        AND a.after->>'version' = '1'
        AND a.after->>'incidentId' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM voucher_claims c
          WHERE c.source_kind = CASE WHEN b.visit_group_id IS NULL THEN 'SOLO' ELSE 'VISIT_GROUP' END
            AND c.source_id = COALESCE(b.visit_group_id, o.id)
        )
      ORDER BY COALESCE(b.visit_group_id, o.id), a.created_at ASC
      LIMIT 1000`, [REPAIR_FAILURE_ACTION, campaign.startsAt]);
    for (const row of incidents) {
      try { await this.issueAutoCompensation(row.incidentId); }
      catch (error) { this.logger.warn(`Repair compensation retry pending: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  async issueCompensation(
    campaignId: string,
    incidentId: string,
  ): Promise<VoucherClaim> {
    this.uuid(incidentId);
    return this.transaction(async (manager) => {
      const campaign = await this.lockCampaign(manager, campaignId);
      const source = await this.evidence.failure(manager, incidentId);
      if (
        !source ||
        source.eligible !== true ||
        source.reason !== 'REPAIR_FAILED' ||
        !['VISIT_GROUP', 'SOLO'].includes(source.sourceKind) ||
        !isUUID(source.sourceId, '4') ||
        !isUUID(source.customerId, '4')
      ) {
        throw new ForbiddenException(
          'Lượt sửa chữa chưa đủ điều kiện nhận ưu đãi.',
        );
      }
      const sourceId = source.sourceId.toLowerCase();
      const customerId = source.customerId.toLowerCase();
      const sourceKey = `${source.sourceKind}:${sourceId}`;
      const existing = await manager.findOne(VoucherClaim, {
        where: { sourceKind: source.sourceKind, sourceId },
      });
      if (existing) {
        if (
          existing.customerId !== customerId ||
          existing.campaignId !== campaignId
        )
          this.conflict();
        return existing;
      }
      if (campaign.kind !== VoucherKind.PERSONAL) this.unavailable();
      this.available(campaign, await this.now(manager));
      return this.newClaim(manager, campaign, customerId, sourceKey, null);
    });
  }

  async apply(
    actor: VoucherActor,
    dto: ApplyVoucherDto,
  ): Promise<CustomerVoucherReservationDto> {
    this.role(actor, Role.CUSTOMER);
    for (const id of [dto.claimId, dto.scopeId, dto.attemptId]) this.uuid(id);
    return this.transaction(async (manager) => {
      const claim = await manager.findOne(VoucherClaim, {
        where: { id: dto.claimId, customerId: actor.id },
      });
      if (!claim) this.unavailable();
      const campaign = await this.lockCampaign(manager, claim.campaignId);
      const now = await this.now(manager);
      await this.expireLocked(manager, campaign.id, now);
      const previous = await manager.findOne(VoucherReservation, {
        where: { customerId: actor.id, attemptId: dto.attemptId },
      });
      if (previous) {
        if (previous.claimId !== claim.id || previous.scopeId !== dto.scopeId)
          this.conflict();
        return customerReservation(previous); // Immutable replay, including RELEASED/EXPIRED; no new TTL.
      }
      this.available(campaign, now);
      // Re-read after campaign lock: a concurrent settlement may have consumed the claim.
      const currentClaim = await manager.findOne(VoucherClaim, {
        where: { id: claim.id, customerId: actor.id },
      });
      if (!currentClaim || currentClaim.redeemedAt) this.conflict();
      const live = await manager.findOne(VoucherReservation, {
        where: { claimId: claim.id, state: ReservationState.RESERVED },
      });
      if (live) this.conflict();
      const usedScope = await manager.find(VoucherReservation, {
        where: { scopeId: dto.scopeId },
      });
      if (
        usedScope.some(
          (item) =>
            item.state === ReservationState.RESERVED ||
            item.state === ReservationState.REDEEMED,
        )
      )
        this.conflict();
      const held = await manager.count(VoucherReservation, {
        where: { campaignId: campaign.id, state: ReservationState.RESERVED },
      });
      // Overdue but unverified/in-flight holds remain unavailable; no silent release.
      if (campaign.redeemed + held >= campaign.quota)
        throw new ConflictException('Ưu đãi đã hết lượt áp dụng.');
      const checkout = await this.evidence.checkout(
        manager,
        actor.id,
        dto.scopeId,
      );
      this.checkoutEligible(checkout, actor.id, dto.scopeId, currentClaim);
      const reservation = await manager.save(
        VoucherReservation,
        manager.create(VoucherReservation, {
          campaignId: campaign.id,
          claimId: claim.id,
          customerId: actor.id,
          scopeId: dto.scopeId,
          attemptId: dto.attemptId,
          state: ReservationState.RESERVED,
          reservedAt: now,
          expiresAt: new Date(+now + APPLY_TTL_MS),
          policySnapshot: structuredClone(currentClaim.policySnapshot),
          checkoutSnapshot: structuredClone(checkout),
          settlementId: null,
        }),
      );
      await this.audit(manager, actor.id, 'RESERVE', reservation.id, {
        expiresAt: reservation.expiresAt.toISOString(),
        snapshotId: checkout.snapshotId,
      });
      return customerReservation(reservation);
    });
  }

  async release(
    actor: VoucherActor,
    reservationId: string,
  ): Promise<CustomerVoucherReservationDto> {
    this.role(actor, Role.CUSTOMER);
    this.uuid(reservationId);
    return this.transaction(async (manager) => {
      const initial = await manager.findOne(VoucherReservation, {
        where: { id: reservationId, customerId: actor.id },
      });
      if (!initial) this.unavailable();
      await this.lockCampaign(manager, initial.campaignId);
      const reservation = await manager.findOne(VoucherReservation, {
        where: { id: reservationId, customerId: actor.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!reservation) this.unavailable();
      if (
        [ReservationState.RELEASED, ReservationState.EXPIRED].includes(
          reservation.state,
        )
      )
        return customerReservation(reservation);
      if (
        reservation.state !== ReservationState.RESERVED ||
        (await this.evidence.canRelease(manager, reservation.id)) !== true
      )
        this.conflict();
      reservation.state =
        +reservation.expiresAt <= +(await this.now(manager))
          ? ReservationState.EXPIRED
          : ReservationState.RELEASED;
      await manager.save(VoucherReservation, reservation);
      await this.audit(manager, actor.id, 'RELEASE', reservation.id, {
        state: reservation.state,
      });
      return customerReservation(reservation);
    });
  }

  /** Internal settlement-only adapter. Input is an ID, never a caller-supplied verdict.
   * No payment initiation/pending/late-callback policy is implemented by this module. */
  async redeemSettled(settlementId: string): Promise<VoucherReservation> {
    this.uuid(settlementId);
    return this.transaction(async (manager) => {
      const proof = await this.evidence.settlement(manager, settlementId);
      if (
        !proof ||
        proof.status !== 'SETTLED' ||
        proof.settlementId !== settlementId ||
        !isUUID(proof.reservationId, '4')
      )
        this.conflict();
      const initial = await manager.findOne(VoucherReservation, {
        where: { id: proof.reservationId },
      });
      if (!initial) this.unavailable();
      const campaign = await this.lockCampaign(manager, initial.campaignId);
      const reservation = await manager.findOne(VoucherReservation, {
        where: { id: initial.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !reservation ||
        proof.customerId !== reservation.customerId ||
        proof.scopeId !== reservation.scopeId ||
        proof.snapshotId !== reservation.checkoutSnapshot.snapshotId
      )
        this.conflict();
      if (reservation.state === ReservationState.REDEEMED) {
        if (reservation.settlementId !== settlementId) this.conflict();
        return reservation;
      }
      const now = await this.now(manager);
      // Fail closed at the exact deadline, even for a delayed otherwise-successful callback.
      if (
        reservation.state !== ReservationState.RESERVED ||
        +now >= +reservation.expiresAt ||
        !(proof.settledAt instanceof Date) ||
        !Number.isFinite(+proof.settledAt) ||
        +proof.settledAt < +reservation.reservedAt ||
        +proof.settledAt >= +reservation.expiresAt ||
        +proof.settledAt > +now ||
        campaign.redeemed >= campaign.quota
      )
        this.conflict();
      const claim = await manager.findOne(VoucherClaim, {
        where: { id: reservation.claimId, customerId: reservation.customerId },
      });
      if (!claim || claim.redeemedAt) this.conflict();
      reservation.state = ReservationState.REDEEMED;
      reservation.settlementId = settlementId;
      claim.redeemedAt = proof.settledAt;
      campaign.redeemed += 1;
      await manager.save(VoucherClaim, claim);
      await manager.save(VoucherCampaign, campaign);
      await manager.save(VoucherReservation, reservation);
      await this.audit(manager, null, 'REDEEM', reservation.id, {
        settlementId,
      });
      return reservation;
    });
  }

  /** Internal sweep entry point; not a background job until registration is approved. */
  async expireCampaign(campaignId: string): Promise<number> {
    return this.transaction(async (manager) => {
      await this.lockCampaign(manager, campaignId);
      return this.expireLocked(manager, campaignId, await this.now(manager));
    });
  }

  private async expireLocked(
    manager: EntityManager,
    campaignId: string,
    now: Date,
  ): Promise<number> {
    const reservations = await manager.find(VoucherReservation, {
      where: { campaignId, state: ReservationState.RESERVED },
    });
    let expired = 0;
    for (const reservation of reservations) {
      if (
        +reservation.expiresAt <= +now &&
        (await this.evidence.canRelease(manager, reservation.id)) === true
      ) {
        reservation.state = ReservationState.EXPIRED;
        await manager.save(VoucherReservation, reservation);
        await this.audit(manager, null, 'EXPIRE', reservation.id, {});
        expired++;
      }
    }
    return expired;
  }

  private checkoutEligible(
    facts: CheckoutFacts,
    customerId: string,
    scopeId: string,
    claim: VoucherClaim,
  ): void {
    const policy = claim.policySnapshot;
    if (
      !facts ||
      facts.customerId !== customerId ||
      facts.scopeId !== scopeId ||
      !isUUID(facts.snapshotId, '4') ||
      facts.finalized !== true ||
      facts.paymentState !== 'NOT_STARTED' ||
      !Number.isSafeInteger(facts.eligibleSubtotalVnd) ||
      facts.eligibleSubtotalVnd < policy.minimumVnd ||
      facts.eligibleSubtotalVnd <= 0 ||
      !Array.isArray(facts.items) ||
      !facts.items.length ||
      facts.items.some(
        (item) =>
          !item ||
          !isUUID(item.categoryId, '4') ||
          !isUUID(item.serviceId, '4') ||
          (policy.categoryIds.length > 0 &&
            !policy.categoryIds.includes(item.categoryId)) ||
          (policy.serviceIds.length > 0 &&
            !policy.serviceIds.includes(item.serviceId)),
      )
    ) {
      throw new ConflictException(
        'Đơn thanh toán chưa đủ điều kiện áp dụng ưu đãi.',
      );
    }
  }

  private async newClaim(
    manager: EntityManager,
    campaign: VoucherCampaign,
    customerId: string,
    sourceKey: string | null,
    actorId: string | null,
  ): Promise<VoucherClaim> {
    const claim = await manager.save(
      VoucherClaim,
      manager.create(VoucherClaim, {
        campaignId: campaign.id,
        campaignKind: campaign.kind,
        customerId,
        sourceKey,
        sourceKind: sourceKey
          ? (sourceKey.split(':')[0] as 'VISIT_GROUP' | 'SOLO' | 'ADMIN_GRANT')
          : null,
        sourceId: sourceKey ? sourceKey.split(':')[1] : null,
        policySnapshot: structuredClone(campaign.policy),
        redeemedAt: null,
      }),
    );
    await this.audit(
      manager,
      actorId,
      sourceKey ? 'ISSUE_COMPENSATION' : 'CLAIM',
      claim.id,
      { campaignId: campaign.id, sourceKey },
    );
    return claim;
  }

  private async lockCampaign(
    manager: EntityManager,
    id: string,
  ): Promise<VoucherCampaign> {
    this.uuid(id);
    const campaign = await manager.findOne(VoucherCampaign, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!campaign)
      throw new NotFoundException('Không tìm thấy chương trình ưu đãi.');
    return campaign;
  }
  private async now(manager: EntityManager): Promise<Date> {
    const result: { now: Date }[] = await manager.query(
      'SELECT clock_timestamp() AS now',
    );
    const now = result[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(+now)) this.conflict();
    return now;
  }
  private available(campaign: VoucherCampaign, now: Date): void {
    if (
      !campaign.active ||
      +now < +campaign.startsAt ||
      +now >= +campaign.endsAt
    )
      this.unavailable();
  }
  private role(actor: VoucherActor, role: Role): void {
    if (!actor || actor.role !== role || !isUUID(actor.id, '4'))
      throw new ForbiddenException(
        'Bạn không có quyền thực hiện thao tác này.',
      );
  }
  private uuid(id: string): void {
    if (!isUUID(id, '4'))
      throw new BadRequestException('Mã tham chiếu không hợp lệ.');
  }
  private unavailable(): never {
    throw new NotFoundException('Không tìm thấy ưu đãi phù hợp.');
  }
  private conflict(): never {
    throw new ConflictException(
      'Ưu đãi chưa thể áp dụng. Vui lòng kiểm tra lại trạng thái thanh toán.',
    );
  }
  private async audit(
    manager: EntityManager,
    actorId: string | null,
    action: string,
    resourceId: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    await manager.save(
      VoucherAudit,
      manager.create(VoucherAudit, { actorId, action, resourceId, snapshot }),
    );
  }
  private async transaction<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if (['23505', '40001', '40P01'].includes(error?.driverError?.code))
        this.conflict();
      throw error;
    }
  }
}
