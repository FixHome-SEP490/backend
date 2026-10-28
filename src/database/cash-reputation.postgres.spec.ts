import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { CashPaymentIntents1793293200000 } from './migrations/1793293200000-CashPaymentIntents';
import { TechnicianResponsibility1793293200001 } from './migrations/1793293200001-TechnicianResponsibility';
import { runCashReputationDevGate } from './cash-reputation-dev-gate';

// CI-only: creates a fresh database on the CI PostgreSQL service at loopback.
// It never reads .env, DATABASE_* or a shared DEV connection string.
describe.skipIf(process.env.CASH_REPUTATION_ISOLATED_PG !== '1')('cash/reputation isolated PostgreSQL release gate', () => {
  const database = `fixhome_cash_rep_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const connection = { type: 'postgres' as const, host: '127.0.0.1', port: 5432,
    username: 'postgres', password: 'postgres', ssl: false, synchronize: false, logging: false };
  let admin: DataSource;
  let db: DataSource;
  let created = false;

  beforeAll(async () => {
    if (process.env.CI !== 'true') throw new Error('Isolated migration test requires CI PostgreSQL service');
    admin = await new DataSource({ ...connection, database: 'postgres' }).initialize();
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    db = await new DataSource({ ...connection, database,
      migrations: [CashPaymentIntents1793293200000, TechnicianResponsibility1793293200001],
      migrationsTransactionMode: 'each' }).initialize();
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE TABLE public.users(id uuid PRIMARY KEY);
      CREATE TABLE public.voucher_campaigns(id uuid PRIMARY KEY, status text);
      CREATE TABLE public.voucher_reservations(id uuid PRIMARY KEY);
      CREATE TABLE public.voucher_payment_links(id uuid PRIMARY KEY);
      CREATE TABLE public.cash_settlements(id uuid PRIMARY KEY);
      CREATE TABLE public.visit_group_payments(id uuid PRIMARY KEY);
      CREATE TABLE public.support_cases(id uuid PRIMARY KEY, service_order_id uuid, technician_id uuid,
        status text, request_intent varchar(32));
      CREATE TABLE public.interruption_rebooks(id uuid PRIMARY KEY);
      ALTER TABLE public.interruption_rebooks ENABLE ROW LEVEL SECURITY;
      CREATE TABLE public.reputation_events(id uuid PRIMARY KEY);
      CREATE TABLE public.migrations(id serial PRIMARY KEY, timestamp bigint NOT NULL, name varchar NOT NULL);
    `);
    for (const [index, name] of [
      'VoucherCore1792994400000', 'VoucherFundingLedger1792994400001',
      'VoucherCampaignLifecycle1793116800000', 'InterruptionWorkflow1793203200000',
    ].entries()) {
      await db.query('INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)', [1792994400000 + index, name]);
    }
    await db.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$`);
  }, 30000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await admin.destroy();
    }
  }, 30000);

  it('applies exactly two additive migrations, protects old rows and replays without DDL', async () => {
    const user = randomUUID(), oldCase = randomUUID(), oldCash = randomUUID(), oldEvent = randomUUID();
    await db.query('INSERT INTO public.users(id) VALUES ($1)', [user]);
    await db.query('INSERT INTO public.support_cases(id,service_order_id,technician_id,status) VALUES ($1,$2,$3,$4)',
      [oldCase, randomUUID(), user, 'open']);
    await db.query('INSERT INTO public.cash_settlements(id) VALUES ($1)', [oldCash]);
    await db.query('INSERT INTO public.reputation_events(id) VALUES ($1)', [oldEvent]);
    await expect(runCashReputationDevGate(db, true)).rejects.toThrow('schema-only DEV deploy first');
    expect(await runCashReputationDevGate(db)).toEqual([
      'CashPaymentIntents1793293200000', 'TechnicianResponsibility1793293200001',
    ]);
    expect(await runCashReputationDevGate(db)).toEqual([]);
    expect((await db.query('SELECT count(*)::int AS n FROM public.migrations'))[0].n).toBe(6);
    expect((await db.query('SELECT id,reason_class,responsibility FROM public.support_cases WHERE id=$1', [oldCase]))[0])
      .toMatchObject({ id: oldCase, reason_class: null, responsibility: null });
    expect((await db.query('SELECT id FROM public.cash_settlements WHERE id=$1', [oldCash]))[0].id).toBe(oldCash);
    expect((await db.query('SELECT id,support_case_id FROM public.reputation_events WHERE id=$1', [oldEvent]))[0])
      .toMatchObject({ id: oldEvent, support_case_id: null });
    const [rls] = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.cash_payment_intents'::regclass");
    expect(rls.relrowsecurity).toBe(true);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await db.query("SELECT has_table_privilege($1,'public.cash_payment_intents','SELECT') AS allowed", [role]))[0].allowed).toBe(false);
    }
  }, 30000);

  it('refuses an unknown pending migration and a private-table SELECT grant on repeat', async () => {
    class Unexpected1793293200002 implements MigrationInterface {
      name = 'Unexpected1793293200002';
      async up(_queryRunner: QueryRunner) { throw new Error('must never execute'); }
      async down(_queryRunner: QueryRunner) { throw new Error('must never execute'); }
    }
    db.migrations.push(new Unexpected1793293200002());
    await expect(runCashReputationDevGate(db)).rejects.toThrow('Unexpected pending migration');
    db.migrations.pop();
    await db.query('GRANT SELECT ON public.cash_payment_intents TO anon');
    await expect(runCashReputationDevGate(db)).rejects.toThrow('Data API role has cash intent access');
    await db.query('REVOKE SELECT ON public.cash_payment_intents FROM anon');
  });

  it('refuses a legacy-mode restart while a new customer cash intent remains pending', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await db.query('INSERT INTO public.users(id) VALUES ($1),($2)', [ids[0], ids[1]]);
    await db.query(`INSERT INTO public.cash_payment_intents(scope_kind,scope_id,customer_id,technician_id,
      status,gross_vnd,customer_due_vnd,allocation_snapshot,command_id)
      VALUES ('SOLO',$1,$2,$3,'pending',120000,90000,'[]'::jsonb,$4)`,
    [randomUUID(), ids[0], ids[1], ids[2]]);
    await expect(runCashReputationDevGate(db)).rejects.toThrow('Pending cash-first intents exist');
    expect(await runCashReputationDevGate(db, true)).toEqual([]);
  });
});
