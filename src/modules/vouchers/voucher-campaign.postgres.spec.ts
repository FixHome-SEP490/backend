import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { VoucherCore1792994400000 } from '../../database/migrations/1792994400000-VoucherCore';
import { VoucherFundingLedger1792994400001 } from '../../database/migrations/1792994400001-VoucherFundingLedger';
import { VoucherCampaignLifecycle1793116800000 } from '../../database/migrations/1793116800000-VoucherCampaignLifecycle';
import { Role } from '../../shared/enums';
import { VOUCHER_ENTITIES, VoucherCampaign, VoucherClaim } from './entities/voucher.entity';
import { VouchersService } from './vouchers.service';
import { VoucherEvidence } from './voucher.ports';
import { CheckoutFacts, SettlementFacts, VoucherDiscount, VoucherKind } from './voucher.types';

// Explicit opt-in. Creates its OWN disposable container/database, never uses dotenv or DB env.
// Minimal legacy tables support the real Core + F4 + lifecycle DDL; this is not a full-app E2E.
describe.skipIf(process.env.VOUCHER_CAMPAIGN_ISOLATED_PG !== '1')('campaign lifecycle isolated PostgreSQL release gate', () => {
  const container = `fixhome_campaign_qa_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  let created = false;
  let db: DataSource;
  let service: VouchersService;
  let genericGuard: string;
  let oldPublished: string;
  let oldPaused: string;
  let historicClaim: string;
  let historicSnapshot: unknown;
  let historicReservation: Record<string, unknown>;
  const admin = { id: randomUUID(), role: Role.ADMIN };
  const checkouts = new Map<string, CheckoutFacts>();
  const settlements = new Map<string, SettlementFacts>();
  const command = (version: number) => ({ version, commandId: randomUUID() });
  const terms = (quota = 100) => ({
    code: `QA_${randomUUID().replaceAll('-', '').toUpperCase()}`,
    name: 'Synthetic campaign', kind: VoucherKind.GENERAL,
    discount: VoucherDiscount.FIXED, value: 10000, capVnd: null,
    minimumVnd: 0, categoryIds: [], serviceIds: [], quota,
    startsAt: new Date(Date.now() - 86400000).toISOString(),
    endsAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const policy = { discount: 'FIXED', value: 10000, capVnd: null, minimumVnd: 0,
    categoryIds: [], serviceIds: [], components: ['LABOR', 'PARTS'] };
  function docker(...args: string[]) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (result.status !== 0) throw new Error(`Isolated campaign PostgreSQL Docker ${args[0]} failed; no external fallback`);
    return result.stdout.trim();
  }
  async function customer() {
    const actor = { id: randomUUID(), role: Role.CUSTOMER };
    await db.query('INSERT INTO public.users(id) VALUES ($1)', [actor.id]);
    return actor;
  }
  async function published(quota = 100) {
    const draft = await service.createCampaign(admin, terms(quota));
    return service.transitionCampaign(admin, draft.id, { status: 'PUBLISHED', ...command(1) });
  }
  async function hold(actor: { id: string; role: Role }, campaign: VoucherCampaign) {
    const claim = await service.claim(actor, campaign.code);
    const facts: CheckoutFacts = { scopeId: randomUUID(), customerId: actor.id, snapshotId: randomUUID(),
      finalized: true, paymentState: 'NOT_STARTED', eligibleSubtotalVnd: 100000,
      items: [{ categoryId: randomUUID(), serviceId: randomUUID() }] };
    checkouts.set(facts.scopeId, facts);
    return service.apply(actor, { claimId: claim.id, scopeId: facts.scopeId, attemptId: randomUUID() });
  }
  async function paid(reservationId: string, actorId: string, scopeId: string) {
    const id = randomUUID();
    settlements.set(id, { settlementId: id, reservationId, customerId: actorId, scopeId,
      snapshotId: checkouts.get(scopeId)!.snapshotId, status: 'SETTLED', settledAt: new Date() });
    return service.redeemSettled(id);
  }

  beforeAll(async () => {
    docker('run', '--detach', '--name', container, '--label', 'fixhome.qa=voucher-campaign',
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=voucher_campaign_qa',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    created = true;
    const identity = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', container));
    const binding = identity['5432/tcp'];
    expect(binding).toHaveLength(1);
    expect(binding[0].HostIp).toBe('127.0.0.1');
    db = new DataSource({ type: 'postgres', host: '127.0.0.1', port: Number(binding[0].HostPort),
      username: 'postgres', password, database: 'voucher_campaign_qa', ssl: false,
      entities: VOUCHER_ENTITIES, synchronize: false,
      migrations: [VoucherCore1792994400000, VoucherFundingLedger1792994400001],
      migrationsTransactionMode: 'each', extra: { max: 8 } });
    // pg_isready inside the container can succeed during Postgres initdb's
    // temporary server; that server exits before the final externally bound
    // server starts. Verify actual TCP + SQL through the mapped loopback port.
    let lastConnectError: unknown;
    for (let n = 0; n < 60; n++) {
      try {
        if (!db.isInitialized) await db.initialize();
        const [row] = await db.query('SELECT current_database() AS name');
        if (row.name !== 'voucher_campaign_qa') throw new Error('Wrong isolated database');
        lastConnectError = null;
        break;
      } catch (error) {
        lastConnectError = error;
        if (db.isInitialized) await db.destroy().catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (lastConnectError || !db.isInitialized) throw new Error('Disposable PostgreSQL never became ready for SQL over localhost TCP');
    await db.query(`
      CREATE TABLE public.users(id uuid PRIMARY KEY);
      CREATE TABLE public.payments(id uuid PRIMARY KEY);
      CREATE TABLE public.cash_settlements(id uuid PRIMARY KEY);
      CREATE TABLE public.visit_group_payments(id uuid PRIMARY KEY);
      CREATE TABLE public.invoices(id uuid PRIMARY KEY, service_order_id uuid);
      CREATE TABLE public.support_cases(id uuid PRIMARY KEY);
      CREATE TABLE public.customer_wallets(id uuid PRIMARY KEY, user_id uuid);
      CREATE TABLE public.customer_wallet_transactions(id uuid PRIMARY KEY, wallet_id uuid,
        type text, amount bigint, balance_before bigint, balance_after bigint, reference_type text, reference_id text);
      CREATE TABLE public.wallet_transactions(id uuid PRIMARY KEY, wallet_id uuid,
        type text, amount bigint, balance_before bigint, balance_after bigint, reference_type text, reference_id text);
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    `);
    expect((await db.runMigrations()).map(m => m.name)).toEqual(['VoucherCore1792994400000', 'VoucherFundingLedger1792994400001']);
    await db.query('INSERT INTO public.users(id) VALUES ($1)', [admin.id]);
    for (const active of [true, false]) {
      const [row] = await db.query(`INSERT INTO public.voucher_campaigns(code,name,kind,policy,starts_at,ends_at,active,quota)
        VALUES ($1,'Historical campaign','GENERAL',$2,now()-interval '1 day',now()+interval '1 day',$3,100) RETURNING id`,
      [active ? 'OLD_ACTIVE' : 'OLD_PAUSED', policy, active]);
      if (active) oldPublished = row.id; else oldPaused = row.id;
    }
    const actor = await customer();
    [historicSnapshot] = await db.query(`INSERT INTO public.voucher_claims(campaign_id,campaign_kind,customer_id,policy_snapshot)
      VALUES ($1,'GENERAL',$2,$3) RETURNING *`, [oldPublished, actor.id, policy]);
    historicClaim = (historicSnapshot as { id: string }).id;
    const historicScope = randomUUID();
    const historicalCheckout = { scopeId: historicScope, customerId: actor.id, snapshotId: randomUUID(),
      finalized: true, paymentState: 'NOT_STARTED', eligibleSubtotalVnd: 100000,
      items: [{ categoryId: randomUUID(), serviceId: randomUUID() }] };
    const [reserved] = await db.query(`INSERT INTO public.voucher_reservations(
      campaign_id,claim_id,customer_id,scope_id,attempt_id,state,reserved_at,expires_at,policy_snapshot,checkout_snapshot)
      VALUES ($1,$2,$3,$4,$5,'RESERVED',now(),now()+interval '15 minutes',$6,$7) RETURNING id`,
    [oldPublished, historicClaim, actor.id, historicScope, randomUUID(), policy, historicalCheckout]);
    await db.transaction(async m => {
      await m.query('UPDATE public.voucher_claims SET redeemed_at=now() WHERE id=$1', [historicClaim]);
      await m.query('UPDATE public.voucher_campaigns SET redeemed=1 WHERE id=$1', [oldPublished]);
      await m.query("UPDATE public.voucher_reservations SET state='REDEEMED',settlement_id=$2 WHERE id=$1", [reserved.id, randomUUID()]);
    });
    [historicSnapshot] = await db.query('SELECT * FROM public.voucher_claims WHERE id=$1', [historicClaim]);
    [historicReservation] = await db.query('SELECT * FROM public.voucher_reservations WHERE id=$1', [reserved.id]);
    [genericGuard] = (await db.query("SELECT pg_get_functiondef('public.voucher_guard_write()'::regprocedure) AS body")).map(row => row.body);
    db.migrations.push(new VoucherCampaignLifecycle1793116800000());
    expect((await db.runMigrations()).map(m => m.name)).toEqual(['VoucherCampaignLifecycle1793116800000']);
    const evidence: VoucherEvidence = {
      checkout: async (_m, customerId, scopeId) => {
        const facts = checkouts.get(scopeId);
        if (!facts || facts.customerId !== customerId) throw new Error('Missing synthetic checkout');
        return facts;
      },
      failure: async () => { throw new Error('Not used'); },
      settlement: async (_m, id) => settlements.get(id)!, canRelease: async () => true,
    };
    service = new VouchersService(db, evidence);
  }, 120000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (created) {
      expect(docker('inspect', '--format', '{{index .Config.Labels "fixhome.qa"}}', container)).toBe('voucher-campaign');
      docker('rm', '--force', container);
    }
  }, 30000);

  it('preserves historical campaigns and claims, keeps inactive campaigns PAUSED and F4 generic guards unchanged', async () => {
    const a = await service.getCampaign(admin, oldPublished), b = await service.getCampaign(admin, oldPaused);
    expect(a).toMatchObject({ status: 'PUBLISHED', active: true, redeemed: 1 });
    expect(b).toMatchObject({ status: 'PAUSED', active: false, redeemed: 0 });
    expect(a.publishedAt).toEqual(a.createdAt);
    expect(b.publishedAt).toEqual(b.createdAt);
    expect((await db.query('SELECT * FROM public.voucher_claims WHERE id=$1', [historicClaim]))[0]).toEqual(historicSnapshot);
    expect((await db.query('SELECT * FROM public.voucher_reservations WHERE id=$1', [historicReservation.id]))[0]).toEqual(historicReservation);
    expect((await db.query("SELECT pg_get_functiondef('public.voucher_guard_write()'::regprocedure) AS body"))[0].body).toBe(genericGuard);
    for (const c of [a, b]) await expect(service.updateCampaign(admin, c.id, { ...terms(), ...command(1) })).rejects.toMatchObject({ status: 409 });
  });

  it('enforces draft-only editing, separate publication, permanent term freeze and irreversible archive in SQL', async () => {
    const draft = await service.createCampaign(admin, terms(7));
    await db.query("UPDATE public.voucher_campaigns SET name='Edited draft',version=2 WHERE id=$1", [draft.id]);
    await expect(db.query("UPDATE public.voucher_campaigns SET name='Unversioned' WHERE id=$1", [draft.id])).rejects.toMatchObject({ driverError: { code: '23514' } });
    await expect(db.query("UPDATE public.voucher_campaigns SET status='PUBLISHED',active=true,published_at=now(),name='Changed on publish',version=3 WHERE id=$1", [draft.id])).rejects.toThrow();
    const c = await service.transitionCampaign(admin, draft.id, { status: 'PUBLISHED', ...command(2) });
    await expect(db.query("UPDATE public.voucher_campaigns SET name='Changed after publish',version=4 WHERE id=$1", [c.id])).rejects.toThrow();
    await service.transitionCampaign(admin, c.id, { status: 'PAUSED', ...command(3) });
    await expect(db.query("UPDATE public.voucher_campaigns SET status='DRAFT',published_at=NULL,version=5 WHERE id=$1", [c.id])).rejects.toThrow();
    await service.transitionCampaign(admin, c.id, { status: 'ARCHIVED', ...command(4) });
    await expect(db.query("UPDATE public.voucher_campaigns SET status='PUBLISHED',active=true,version=6 WHERE id=$1", [c.id])).rejects.toThrow();
    await expect(db.query('DELETE FROM public.voucher_campaigns WHERE id=$1', [c.id])).rejects.toThrow();
  });

  it('serializes edit against publication: one winner and one HTTP 409, with one durable command', async () => {
    const draft = await service.createCampaign(admin, terms());
    const race = await Promise.allSettled([
      service.updateCampaign(admin, draft.id, { ...terms(), ...command(1) }),
      service.transitionCampaign(admin, draft.id, { status: 'PUBLISHED', ...command(1) }),
    ]);
    expect(race.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((race.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect((await db.query("SELECT count(*)::int AS n FROM public.voucher_audit WHERE resource_id=$1 AND action IN ('EDIT_CAMPAIGN','CAMPAIGN_LIFECYCLE')", [draft.id]))[0].n).toBe(1);
  });

  it('replays a published command after JSONB round-trip without another audit, rejecting payload reuse', async () => {
    const draft = await service.createCampaign(admin, terms());
    const cmd = { status: 'PUBLISHED' as const, ...command(1) };
    await service.transitionCampaign(admin, draft.id, cmd);
    expect(await service.transitionCampaign(admin, draft.id, cmd)).toMatchObject({ status: 'PUBLISHED', version: 2 });
    await expect(service.transitionCampaign(admin, draft.id, { ...cmd, status: 'ARCHIVED' })).rejects.toMatchObject({ status: 409 });
    expect((await db.query("SELECT count(*)::int AS n FROM public.voucher_audit WHERE snapshot->>'commandId'=$1", [cmd.commandId]))[0].n).toBe(1);
  });

  it('serializes claim against archive and rejects every new claim or apply after archive wins', async () => {
    const c = await published(), actor = await customer();
    const race = await Promise.allSettled([
      service.claim(actor, c.code),
      service.transitionCampaign(admin, c.id, { status: 'ARCHIVED', ...command(2) }),
    ]);
    expect(race[1].status).toBe('fulfilled');
    expect(await db.getRepository(VoucherClaim).countBy({ campaignId: c.id })).toBe(race[0].status === 'fulfilled' ? 1 : 0);
    await expect(service.claim(await customer(), c.code)).rejects.toMatchObject({ status: 404 });
    await expect(hold(actor, c)).rejects.toMatchObject({ status: 404 });
  });

  it('allows 101 saved codes, accepts exactly 100 paid settlements and prevents paid customer reuse', async () => {
    const c = await published();
    const actors = await Promise.all(Array.from({ length: 101 }, customer));
    await Promise.all(actors.map(actor => service.claim(actor, c.code)));
    expect(await db.getRepository(VoucherClaim).countBy({ campaignId: c.id })).toBe(101);
    for (const actor of actors.slice(0, 100)) {
      const r = await hold(actor, c);
      await paid(r.id, actor.id, r.scopeId);
    }
    expect((await service.getCampaign(admin, c.id)).redeemed).toBe(100);
    await expect(hold(actors[100], c)).rejects.toMatchObject({ status: 409 });
    await expect(hold(actors[0], c)).rejects.toMatchObject({ status: 409 });
    await expect(db.query('UPDATE public.voucher_campaigns SET redeemed=99 WHERE id=$1', [c.id])).rejects.toMatchObject({ driverError: { code: '23514' } });
  }, 90000);

  it('denies API database roles and proves non-owner app-role RLS must be deliberately configured', async () => {
    const c = await service.createCampaign(admin, terms());
    expect((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.voucher_campaigns'::regclass"))[0].relrowsecurity).toBe(true);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await db.query("SELECT has_table_privilege($1,'public.voucher_campaigns','INSERT,UPDATE,DELETE') AS allowed", [role]))[0].allowed).toBe(false);
    }
    await db.query(`CREATE ROLE campaign_app_probe NOLOGIN;
      GRANT USAGE ON SCHEMA public TO campaign_app_probe;
      GRANT SELECT,INSERT,UPDATE ON public.voucher_campaigns TO campaign_app_probe;
      GRANT SELECT ON public.voucher_claims,public.voucher_reservations TO campaign_app_probe;`);
    await db.transaction(async m => {
      await m.query('SET LOCAL ROLE campaign_app_probe');
      expect(await m.query('SELECT id FROM public.voucher_campaigns')).toEqual([]);
    });
    await db.query('CREATE POLICY campaign_probe_policy ON public.voucher_campaigns TO campaign_app_probe USING (true) WITH CHECK (true)');
    await db.transaction(async m => {
      await m.query('SET LOCAL ROLE campaign_app_probe');
      expect((await m.query('SELECT id FROM public.voucher_campaigns WHERE id=$1', [c.id]))[0].id).toBe(c.id);
      await m.query("UPDATE public.voucher_campaigns SET name='App draft',version=2 WHERE id=$1", [c.id]);
    });
    await service.transitionCampaign(admin, c.id, { status: 'PUBLISHED', ...command(2) });
    await expect(db.transaction(async m => {
      await m.query('SET LOCAL ROLE campaign_app_probe');
      await m.query("UPDATE public.voucher_campaigns SET name='Forbidden',version=4 WHERE id=$1", [c.id]);
    })).rejects.toThrow();
    await db.query('DROP POLICY campaign_probe_policy ON public.voucher_campaigns');
  });
});
