import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { VoucherCore1792994400000 } from '../../database/migrations/1792994400000-VoucherCore';
import { Role } from '../../shared/enums';
import {
  VOUCHER_ENTITIES,
  VoucherClaim,
  VoucherReservation,
} from './entities/voucher.entity';
import { VouchersService } from './vouchers.service';
import { VoucherEvidence } from './voucher.ports';
import {
  CheckoutFacts,
  FailureFacts,
  ReservationState,
  SettlementFacts,
  VoucherActor,
  VoucherDiscount,
  VoucherKind,
} from './voucher.types';

// Opt-in only. No dotenv, project DataSource, external URL or database env credentials.
// Evidence is synthetic; SQL/locks/transactions/indexes below are real PostgreSQL.
const enabled = process.env.VOUCHER_ISOLATED_PG === '1';
describe.skipIf(!enabled)(
  'voucher disposable PostgreSQL — mandatory activation gate',
  () => {
    let db: DataSource;
    let service: VouchersService;
    let admin: VoucherActor;
    const checkouts = new Map<string, CheckoutFacts>();
    const failures = new Map<string, FailureFacts>();
    const settlements = new Map<string, SettlementFacts>();
    const blocked = new Set<string>();
    let roundTrip: string[];
    function docker(...args: string[]): string {
      const result = spawnSync('docker', args, {
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
      });
      // Do not include run arguments/credentials or inspect payload in failure output.
      if (result.status !== 0)
        throw new Error(
          `Disposable PostgreSQL Docker operation failed: ${args[0]}; no external DB fallback allowed`,
        );
      return result.stdout.trim();
    }
    async function customer(): Promise<VoucherActor> {
      const actor = { id: randomUUID(), role: Role.CUSTOMER };
      await db.query('INSERT INTO users(id) VALUES ($1)', [actor.id]);
      return actor;
    }
    async function campaign(kind = VoucherKind.GENERAL, quota = 100) {
      return service.createCampaign(admin, {
        code: `PG_${randomUUID().replaceAll('-', '').toUpperCase()}`,
        name: 'Synthetic voucher PostgreSQL',
        kind,
        discount: VoucherDiscount.PERCENT,
        value: 10,
        capVnd: 50000,
        minimumVnd: 10000,
        categoryIds: [],
        serviceIds: [],
        quota,
        startsAt: new Date(Date.now() - 86400000).toISOString(),
        endsAt: new Date(Date.now() + 86400000).toISOString(),
      });
    }
    function checkout(actor: VoucherActor): CheckoutFacts {
      const facts: CheckoutFacts = {
        customerId: actor.id,
        scopeId: randomUUID(),
        snapshotId: randomUUID(),
        finalized: true,
        paymentState: 'NOT_STARTED',
        eligibleSubtotalVnd: 100000,
        items: [{ categoryId: randomUUID(), serviceId: randomUUID() }],
      };
      checkouts.set(facts.scopeId, facts);
      return facts;
    }
    function settlement(
      reservation: { id: string; scopeId: string },
      actor: VoucherActor,
    ): string {
      const id = randomUUID();
      settlements.set(id, {
        settlementId: id,
        reservationId: reservation.id,
        customerId: actor.id,
        scopeId: reservation.scopeId,
        snapshotId: checkouts.get(reservation.scopeId)!.snapshotId,
        status: 'SETTLED',
        settledAt: new Date(),
      });
      return id;
    }
    async function reserved() {
      const actor = await customer(),
        c = await campaign();
      const claim = await service.claim(actor, c.code),
        facts = checkout(actor);
      const dto = {
        claimId: claim.id,
        scopeId: facts.scopeId,
        attemptId: randomUUID(),
      };
      return {
        actor,
        campaign: c,
        claim,
        facts,
        dto,
        reservation: await service.apply(actor, dto),
      };
    }

    beforeAll(async () => {
      const identity = JSON.parse(
        docker(
          'inspect',
          '--format',
          '{"Name":{{json .Name}},"Image":{{json .Config.Image}},"Ports":{{json .NetworkSettings.Ports}}}',
          'fixhome_t2_qa_pg_20261026',
        ),
      );
      expect(identity.Name).toBe('/fixhome_t2_qa_pg_20261026');
      expect(identity.Image).toBe('postgres:16-alpine');
      expect(identity.Ports['5432/tcp']).toEqual([
        { HostIp: '127.0.0.1', HostPort: '55432' },
      ]);
      const password = process.env.VOUCHER_TEST_PASSWORD;
      if (!password)
        throw new Error(
          'VOUCHER_TEST_PASSWORD is required; no external DB fallback allowed',
        );
      db = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port: 55432,
        username: 't2qa',
        password,
        database: 'fixhome_t2_voucher',
        ssl: false,
        synchronize: false,
        entities: VOUCHER_ENTITIES,
        migrations: [VoucherCore1792994400000],
        migrationsTransactionMode: 'each',
        extra: { max: 8 },
      });
      await db.initialize();
      expect(
        (
          await db.query('SELECT current_database() AS db, current_user AS usr')
        )[0],
      ).toEqual({ db: 'fixhome_t2_voucher', usr: 't2qa' });
      // Owner permits reset of this exact isolated database only; never another DB in the container.
      await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
      // Minimal existing-user FK fixture; this is not a full legacy migration-chain rehearsal.
      await db.query('CREATE TABLE users(id uuid PRIMARY KEY)');
      roundTrip = (await db.runMigrations()).map((m) => m.name);
      await db.undoLastMigration();
      roundTrip.push('EMPTY_DOWN');
      roundTrip.push(...(await db.runMigrations()).map((m) => m.name));
      admin = { id: randomUUID(), role: Role.ADMIN };
      await db.query('INSERT INTO users(id) VALUES ($1)', [admin.id]);
      const evidence: VoucherEvidence = {
        checkout: async (_manager, customerId, scopeId) => {
          const facts = checkouts.get(scopeId);
          if (!facts || facts.customerId !== customerId)
            throw new Error('Synthetic evidence unavailable');
          return facts;
        },
        failure: async (_manager, incidentId) => failures.get(incidentId)!,
        settlement: async (_manager, id) => settlements.get(id)!,
        canRelease: async (_manager, id) => !blocked.has(id),
      };
      service = new VouchersService(db, evidence);
    }, 120000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
    }, 30000);

    it('rehearses additive up / empty down / up and uses separate PostgreSQL connections', async () => {
      expect(roundTrip).toEqual([
        'VoucherCore1792994400000',
        'EMPTY_DOWN',
        'VoucherCore1792994400000',
      ]);
      const a = db.createQueryRunner(),
        b = db.createQueryRunner();
      try {
        await a.connect();
        await b.connect();
        expect((await a.query('SELECT pg_backend_pid() AS id'))[0].id).not.toBe(
          (await b.query('SELECT pg_backend_pid() AS id'))[0].id,
        );
      } finally {
        await a.release();
        await b.release();
      }
    });

    it('admits one of concurrent 100th/101st holds and consumes exactly 100 verified-fixture settlements', async () => {
      const c = await campaign();
      const actors = await Promise.all(
        Array.from({ length: 101 }, () => customer()),
      );
      const claims = await Promise.all(
        actors.map((actor) => service.claim(actor, c.code)),
      );
      const dtos = actors.map((actor, i) => ({
        claimId: claims[i].id,
        scopeId: checkout(actor).scopeId,
        attemptId: randomUUID(),
      }));
      const first = await Promise.all(
        actors.slice(0, 99).map((actor, i) => service.apply(actor, dtos[i])),
      );
      const last = await Promise.allSettled([
        service.apply(actors[99], dtos[99]),
        service.apply(actors[100], dtos[100]),
      ]);
      expect(last.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(last.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(
        (
          await db.query('SELECT redeemed FROM voucher_campaigns WHERE id=$1', [
            c.id,
          ])
        )[0].redeemed,
      ).toBe(0);
      expect(
        await db.getRepository(VoucherClaim).countBy({ campaignId: c.id }),
      ).toBe(101);
      const holds = await db
        .getRepository(VoucherReservation)
        .findBy({ campaignId: c.id });
      expect(holds).toHaveLength(100);
      for (const hold of holds)
        expect(+hold.expiresAt - +hold.reservedAt).toBe(900000);
      const ids = holds.map((hold) =>
        settlement(
          hold,
          actors.find((actor) => actor.id === hold.customerId)!,
        ),
      );
      await Promise.all(ids.map((id) => service.redeemSettled(id)));
      await Promise.all(ids.map((id) => service.redeemSettled(id)));
      expect(
        (
          await db.query('SELECT redeemed FROM voucher_campaigns WHERE id=$1', [
            c.id,
          ])
        )[0].redeemed,
      ).toBe(100);
      const another = await customer(),
        claim = await service.claim(another, c.code);
      await expect(
        service.apply(another, {
          claimId: claim.id,
          scopeId: checkout(another).scopeId,
          attemptId: randomUUID(),
        }),
      ).rejects.toThrow();
      expect(first).toHaveLength(99);
    }, 90000);

    it('makes concurrent claim/apply retries idempotent without extending TTL or leaking entities', async () => {
      const actor = await customer(),
        c = await campaign();
      const claims = await Promise.all([
        service.claim(actor, c.code),
        service.claim(actor, c.code),
      ]);
      expect(claims[0].id).toBe(claims[1].id);
      const dto = {
        claimId: claims[0].id,
        scopeId: checkout(actor).scopeId,
        attemptId: randomUUID(),
      };
      const holds = await Promise.all([
        service.apply(actor, dto),
        service.apply(actor, dto),
      ]);
      expect(holds[0].id).toBe(holds[1].id);
      expect(holds[0].expiresAt).toEqual(holds[1].expiresAt);
      const json = JSON.stringify({
        claims,
        holds,
        wallet: await service.wallet(actor),
      });
      for (const key of [
        'customerId',
        'sourceKey',
        'sourceKind',
        'sourceId',
        'campaignKind',
        'checkoutSnapshot',
        'settlementId',
      ])
        expect(json).not.toContain(`"${key}":`);
      await expect(service.apply(await customer(), dto)).rejects.toThrow();
      await expect(
        service.release(await customer(), holds[0].id),
      ).rejects.toThrow();
    });

    it('uniquely canonicalizes two child incidents to one group, across campaigns, while allowing another solo visit', async () => {
      const actor = await customer(),
        a = await campaign(VoucherKind.PERSONAL),
        b = await campaign(VoucherKind.PERSONAL);
      const group = randomUUID(),
        eventA = randomUUID(),
        eventB = randomUUID();
      const facts: FailureFacts = {
        sourceKind: 'VISIT_GROUP',
        sourceId: group.toUpperCase(),
        customerId: actor.id.toUpperCase(),
        reason: 'REPAIR_FAILED',
        eligible: true,
      };
      failures.set(eventA, facts);
      failures.set(eventB, facts);
      const race = await Promise.allSettled([
        service.issueCompensation(a.id, eventA),
        service.issueCompensation(b.id, eventB),
      ]);
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const winner = race.find(
        (r) => r.status === 'fulfilled',
      ) as PromiseFulfilledResult<VoucherClaim>;
      expect(
        (
          await service.handleRepairFailure(winner.value.campaignId, {
            type: 'REPAIR_FAILURE_ELIGIBLE_V1',
            incidentId: eventB,
          })
        ).id,
      ).toBe(winner.value.id);
      const soloIncident = randomUUID();
      failures.set(soloIncident, {
        ...facts,
        sourceKind: 'SOLO',
        sourceId: randomUUID(),
      });
      expect(
        (await service.issueCompensation(winner.value.campaignId, soloIncident))
          .id,
      ).not.toBe(winner.value.id);
      expect(
        await db.getRepository(VoucherClaim).countBy({ customerId: actor.id }),
      ).toBe(2);
    });

    it('expires overdue holds only after release evidence, never from an index clock predicate', async () => {
      const actor = await customer(),
        c = await campaign(),
        claim = await service.claim(actor, c.code),
        facts = checkout(actor);
      const reservedAt = new Date(Date.now() - 1000000);
      const hold = await db.getRepository(VoucherReservation).save({
        campaignId: c.id,
        claimId: claim.id,
        customerId: actor.id,
        scopeId: facts.scopeId,
        attemptId: randomUUID(),
        state: ReservationState.RESERVED,
        reservedAt,
        expiresAt: new Date(+reservedAt + 900000),
        policySnapshot: claim.policySnapshot,
        checkoutSnapshot: facts,
        settlementId: null,
      });
      blocked.add(hold.id);
      expect(await service.expireCampaign(c.id)).toBe(0);
      await expect(service.release(actor, hold.id)).rejects.toThrow();
      await expect(
        service.redeemSettled(settlement(hold, actor)),
      ).rejects.toThrow();
      blocked.delete(hold.id);
      expect(await service.expireCampaign(c.id)).toBe(1);
      expect(
        (
          await db
            .getRepository(VoucherReservation)
            .findOneByOrFail({ id: hold.id })
        ).state,
      ).toBe(ReservationState.EXPIRED);
      expect(
        (
          await service.apply(actor, {
            claimId: claim.id,
            scopeId: facts.scopeId,
            attemptId: randomUUID(),
          })
        ).state,
      ).toBe(ReservationState.RESERVED);
    });

    it('enforces FK, immutable history, policy validation and deferred paid-counter invariants', async () => {
      const r = await reserved();
      await expect(
        db.query('UPDATE voucher_campaigns SET redeemed=1 WHERE id=$1', [
          r.campaign.id,
        ]),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
      await expect(
        db.query('UPDATE voucher_campaigns SET policy=$2 WHERE id=$1', [
          r.campaign.id,
          { ...r.campaign.policy, discount: null },
        ]),
      ).rejects.toThrow();
      const other = await customer(),
        facts = checkout(other);
      const owner = await customer();
      const unreservedClaim = await service.claim(owner, r.campaign.code);
      const reservedAt = new Date();
      await expect(
        db.getRepository(VoucherReservation).save({
          campaignId: r.campaign.id,
          claimId: unreservedClaim.id,
          customerId: other.id,
          scopeId: facts.scopeId,
          attemptId: randomUUID(),
          state: ReservationState.RESERVED,
          reservedAt,
          expiresAt: new Date(+reservedAt + 900000),
          policySnapshot: r.claim.policySnapshot,
          checkoutSnapshot: facts,
          settlementId: null,
        }),
      ).rejects.toMatchObject({ driverError: { code: '23503' } });
      for (const invalid of [
        { ...r.campaign.policy, discount: null },
        { ...r.campaign.policy, value: 101 },
        { ...r.campaign.policy, capVnd: 1.5 },
        { ...r.campaign.policy, serviceIds: ['forged'] },
      ]) {
        expect(
          (
            await db.query('SELECT voucher_policy_valid($1::jsonb) AS valid', [
              JSON.stringify(invalid),
            ])
          )[0].valid,
        ).toBe(false);
      }
      await expect(
        db.query(
          "UPDATE voucher_reservations SET expires_at=expires_at+interval '1 minute' WHERE id=$1",
          [r.reservation.id],
        ),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
      await expect(db.query('DELETE FROM voucher_audit')).rejects.toThrow();
      await expect(db.undoLastMigration()).rejects.toThrow(
        'Voucher history exists',
      );
      expect(
        await db.getRepository(VoucherClaim).countBy({ id: r.claim.id }),
      ).toBe(1);
    });

    it('serializes release versus settlement on the same hold without a double terminal effect', async () => {
      const r = await reserved(),
        id = settlement(r.reservation, r.actor);
      const results = await Promise.allSettled([
        service.release(r.actor, r.reservation.id),
        service.redeemSettled(id),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const hold = await db
        .getRepository(VoucherReservation)
        .findOneByOrFail({ id: r.reservation.id });
      expect([ReservationState.REDEEMED, ReservationState.RELEASED]).toContain(
        hold.state,
      );
      const redeemed = (
        await db.query('SELECT redeemed FROM voucher_campaigns WHERE id=$1', [
          r.campaign.id,
        ])
      )[0].redeemed;
      expect(redeemed).toBe(hold.state === ReservationState.REDEEMED ? 1 : 0);
    });

    it('admits only one voucher for a checkout raced across different campaigns', async () => {
      const actor = await customer(),
        a = await campaign(),
        b = await campaign(),
        facts = checkout(actor);
      const first = await service.claim(actor, a.code),
        second = await service.claim(actor, b.code);
      const results = await Promise.allSettled(
        [first, second].map((claim) =>
          service.apply(actor, {
            claimId: claim.id,
            scopeId: facts.scopeId,
            attemptId: randomUUID(),
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(
        await db
          .getRepository(VoucherReservation)
          .countBy({ scopeId: facts.scopeId }),
      ).toBe(1);
    });

    it('rolls back redemption if a real audit insert fails', async () => {
      const r = await reserved(),
        id = settlement(r.reservation, r.actor);
      await db.query(`CREATE FUNCTION voucher_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action = 'REDEEM' THEN RAISE EXCEPTION 'Synthetic audit rejection'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER voucher_test_audit_failure BEFORE INSERT ON voucher_audit FOR EACH ROW EXECUTE FUNCTION voucher_test_reject_audit()`);
      try {
        await expect(service.redeemSettled(id)).rejects.toThrow(
          'Synthetic audit rejection',
        );
        expect(
          (
            await db
              .getRepository(VoucherReservation)
              .findOneByOrFail({ id: r.reservation.id })
          ).state,
        ).toBe(ReservationState.RESERVED);
        expect(
          (
            await db
              .getRepository(VoucherClaim)
              .findOneByOrFail({ id: r.claim.id })
          ).redeemedAt,
        ).toBeNull();
        expect(
          (
            await db.query(
              'SELECT redeemed FROM voucher_campaigns WHERE id=$1',
              [r.campaign.id],
            )
          )[0].redeemed,
        ).toBe(0);
      } finally {
        await db.query(
          'DROP TRIGGER voucher_test_audit_failure ON voucher_audit; DROP FUNCTION voucher_test_reject_audit()',
        );
      }
    });
  },
);
