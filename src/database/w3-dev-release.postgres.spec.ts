import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { CashPaymentIntents1793293200000 } from './migrations/1793293200000-CashPaymentIntents';
import { TechnicianResponsibility1793293200001 } from './migrations/1793293200001-TechnicianResponsibility';
import { WarehouseDeliverySplit1793466000004 } from './migrations/1793466000004-WarehouseDeliverySplit';
import { DeliveryConsentState1793466000005 } from './migrations/1793466000005-DeliveryConsentState';
import { W3DeliveryOperatingPolicy1793466000006 } from './migrations/1793466000006-W3DeliveryOperatingPolicy';
import { WarehouseDeliveryPhysical1793466000007 } from './migrations/1793466000007-WarehouseDeliveryPhysical';
import { W3DeliveryPolicyLifecycle1793466000009 } from './migrations/1793466000009-W3DeliveryPolicyLifecycle';
import { DeliveryConditionalFeeTerms1793466000010 } from './migrations/1793466000010-DeliveryConditionalFeeTerms';
import { W3PrequoteCommission1793466000011 } from './migrations/1793466000011-W3PrequoteCommission';
import { W3DeductionPreparation1793466000012 } from './migrations/1793466000012-W3DeductionPreparation';
import { W3ShippingSafetyCap1793466000013 } from './migrations/1793466000013-W3ShippingSafetyCap';
import { W3PositivePhysicalDelivery1793466000014 } from './migrations/1793466000014-W3PositivePhysicalDelivery';
import { W3InvoicePaymentEnable1793466000015 } from './migrations/1793466000015-W3InvoicePaymentEnable';
import {
  CASH_MIGRATIONS,
  runW3DevGate,
  W3_MIGRATIONS,
  W3_PREREQUISITES,
} from './w3-dev-release-gate';

// 0008 is authored in the W3 finance/delivery worktree and cherry-picked into
// this Backend tree before CI. The conditional glob keeps this gate branch
// compilable before that integration; the isolated suite fails closed if the
// migration is still absent when CI runs it.
// @ts-ignore import.meta.glob is transformed by Vitest, not the CommonJS backend.
const zeroFeeModules = import.meta.glob('./migrations/1793466000008-*.ts', {
  eager: true,
});
const ZeroFeeOperations = (
  Object.values(zeroFeeModules)[0] as
    | {
        DeliveryZeroFeeOperations1793466000008?: new () => MigrationInterface;
      }
    | undefined
)?.DeliveryZeroFeeOperations1793466000008;

type MigrationClass = new () => MigrationInterface;
const w3MigrationClasses: MigrationClass[] = [
  WarehouseDeliverySplit1793466000004,
  DeliveryConsentState1793466000005,
  W3DeliveryOperatingPolicy1793466000006,
  WarehouseDeliveryPhysical1793466000007,
];
if (ZeroFeeOperations) w3MigrationClasses.push(ZeroFeeOperations);
w3MigrationClasses.push(W3DeliveryPolicyLifecycle1793466000009);
w3MigrationClasses.push(DeliveryConditionalFeeTerms1793466000010);
w3MigrationClasses.push(W3PrequoteCommission1793466000011);
w3MigrationClasses.push(W3DeductionPreparation1793466000012);
w3MigrationClasses.push(W3ShippingSafetyCap1793466000013);
w3MigrationClasses.push(W3PositivePhysicalDelivery1793466000014);
w3MigrationClasses.push(W3InvoicePaymentEnable1793466000015);

// CI-only: creates a fresh database on the CI PostgreSQL service at loopback.
// It never reads .env, DATABASE_* or a shared DEV connection string.
describe.skipIf(process.env.W3_DEV_ISOLATED_PG !== '1')(
  'W3 isolated PostgreSQL release gate',
  () => {
    const database = `fixhome_w3_gate_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const connection = {
      type: 'postgres' as const,
      host: '127.0.0.1',
      port: 5432,
      username: 'postgres',
      password: 'postgres',
      ssl: false,
      synchronize: false,
      logging: false,
    };
    let admin: DataSource;
    let db: DataSource;
    let created = false;

    class FailingPhysicalMigration implements MigrationInterface {
      name = W3_MIGRATIONS[3];
      constructor(private readonly inner: MigrationInterface) {}
      async up(queryRunner: QueryRunner): Promise<void> {
        await this.inner.up(queryRunner);
        throw new Error('fault injection after partial W3 schema');
      }
      async down(queryRunner: QueryRunner): Promise<void> {
        await this.inner.down(queryRunner);
      }
    }

    class FailingZeroFeeMigration implements MigrationInterface {
      name = W3_MIGRATIONS[4];
      constructor(private readonly inner: MigrationInterface) {}
      async up(queryRunner: QueryRunner): Promise<void> {
        await this.inner.up(queryRunner);
        throw new Error('fault injection after additive zero-fee schema');
      }
      async down(queryRunner: QueryRunner): Promise<void> {
        await this.inner.down(queryRunner);
      }
    }

    beforeAll(async () => {
      if (process.env.CI !== 'true')
        throw new Error(
          'Isolated migration test requires CI PostgreSQL service',
        );
      if (!ZeroFeeOperations) {
        throw new Error(
          'DeliveryZeroFeeOperations1793466000008 is missing; cherry-pick it into Backend before isolated W3 gate CI',
        );
      }
      admin = await new DataSource({
        ...connection,
        database: 'postgres',
      }).initialize();
      await admin.query(`CREATE DATABASE "${database}"`);
      created = true;
      db = await new DataSource({
        ...connection,
        database,
        migrations: [
          CashPaymentIntents1793293200000,
          TechnicianResponsibility1793293200001,
          ...w3MigrationClasses,
        ],
        migrationsTransactionMode: 'each',
      }).initialize();
      await db.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE TABLE public.users(id uuid PRIMARY KEY, role text, is_active boolean, status text);
      CREATE TABLE public.invoices(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_order_id uuid, labor_total bigint, parts_total bigint, fixhome_parts_total bigint,
        technician_parts_total bigint, technician_part_warranty_fee_total bigint,
        shipping_fee bigint NOT NULL DEFAULT 0, grand_total bigint, commission_base bigint,
        commission_rate_snapshot numeric, commission_amount bigint);
      CREATE TABLE public.part_requests(id uuid PRIMARY KEY, service_order_id uuid, technician_id uuid,
        fulfillment_method text, status text, request_type text, quotation_id uuid,
        additional_cost_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
        shipping_fee bigint NOT NULL DEFAULT 0, received_at timestamptz, qr_token text);
      CREATE TABLE public.service_orders(id uuid PRIMARY KEY, booking_id uuid, status text,
        completion_requested_at timestamptz);
      CREATE TABLE public.technician_assignments(id uuid PRIMARY KEY, service_order_id uuid,
        technician_id uuid, is_active boolean, activated_at timestamptz);
      CREATE TABLE public.warehouses(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        status text, responsible_user_id uuid);
      CREATE TABLE public.quotations(id uuid PRIMARY KEY, status text, decided_at timestamptz,
        service_order_id uuid, technician_id uuid, version integer);
      CREATE TABLE public.additional_cost_requests(id uuid PRIMARY KEY, status text, decided_at timestamptz,supersedes_id uuid,total_labor_delta bigint,
        service_order_id uuid, technician_id uuid, decided_by_customer_id uuid,
        shipping_fee bigint NOT NULL DEFAULT 0, fulfillment_method text);
      CREATE TABLE public.bookings(id uuid PRIMARY KEY, customer_id uuid, visit_group_id uuid,pricing_mode_snapshot text,fixed_unit_price_snapshot numeric,quantity integer,scope_snapshot text);
      CREATE TABLE public.quotation_items(id uuid PRIMARY KEY,quotation_id uuid,type text,description text,quantity integer,unit_price bigint,line_total bigint);
      CREATE TABLE public.system_configs(key varchar(128) PRIMARY KEY,value text,value_type text,description text,updated_at timestamptz,updated_by_user_id uuid);
      CREATE TABLE public.fixhome_parts(id uuid PRIMARY KEY DEFAULT uuid_generate_v4());
      CREATE TABLE public.part_request_items(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        part_request_id uuid, part_catalog_id uuid, part_source text, quantity integer,
        usage_status text NOT NULL DEFAULT 'pending');
      CREATE TABLE public.part_custodies(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_order_id uuid);
      CREATE TABLE public.additional_cost_items(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        request_id uuid, type text,description text, part_source text, part_catalog_id uuid, quantity integer,unit_price bigint,line_total bigint);
      CREATE TABLE public.audit_logs(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), resource_type text,
        resource_id text, actor_user_id uuid, actor_role text, action text, before jsonb, after jsonb);
      CREATE TABLE public.roles(id uuid PRIMARY KEY, code text);
      CREATE TABLE public.permissions(id uuid PRIMARY KEY, code text);
      CREATE TABLE public.role_permissions(role_id uuid, permission_id uuid);
      CREATE TABLE public.voucher_campaigns(id uuid PRIMARY KEY, status text);
      CREATE TABLE public.support_cases(id uuid PRIMARY KEY, request_intent varchar(32));
      CREATE TABLE public.interruption_rebooks(id uuid PRIMARY KEY);
      ALTER TABLE public.interruption_rebooks ENABLE ROW LEVEL SECURITY;
      CREATE TABLE public.warehouse_stock(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        warehouse_id uuid REFERENCES public.warehouses(id), part_id uuid REFERENCES public.fixhome_parts(id),
        on_hand integer NOT NULL DEFAULT 0, reserved integer NOT NULL DEFAULT 0,
        version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.stock_movements(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        warehouse_id uuid, part_id uuid);
      CREATE FUNCTION public.prevent_stock_movement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Stock movements are append-only'; END $$;
      CREATE TRIGGER protect_stock_movements BEFORE UPDATE OR DELETE ON public.stock_movements
        FOR EACH ROW EXECUTE FUNCTION public.prevent_stock_movement_mutation();
      CREATE TABLE public.part_request_warehouse_allocations(part_request_id uuid PRIMARY KEY);
      CREATE TABLE public.warehouse_fulfillment_commands(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        part_request_id uuid);
      CREATE TABLE public.warehouse_fulfillment_movements(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        command_id uuid);
      CREATE TRIGGER protect_warehouse_fulfillment_commands BEFORE UPDATE OR DELETE
        ON public.warehouse_fulfillment_commands FOR EACH ROW
        EXECUTE FUNCTION public.prevent_stock_movement_mutation();
      CREATE TRIGGER protect_warehouse_fulfillment_movements BEFORE UPDATE OR DELETE
        ON public.warehouse_fulfillment_movements FOR EACH ROW
        EXECUTE FUNCTION public.prevent_stock_movement_mutation();
      ALTER TABLE public.part_request_warehouse_allocations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.warehouse_fulfillment_commands ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.warehouse_fulfillment_movements ENABLE ROW LEVEL SECURITY;
      CREATE TABLE public.migrations(id serial PRIMARY KEY, timestamp bigint NOT NULL, name varchar NOT NULL);
    `);
      // The exact cash/reputation pair stays pending, as it is when the W3 gate
      // runs in deploy. The unchanged cash gate applies it immediately after.
      for (const name of W3_PREREQUISITES) {
        await db.query(
          'INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)',
          [Number(name.slice(-13)), name],
        );
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
        if (created)
          await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        await admin.destroy();
      }
    }, 30000);

    it('rolls back every W3 migration and ledger row when a later migration fails', async () => {
      const index = db.migrations.findIndex(
        (migration) => migration.name === W3_MIGRATIONS[3],
      );
      const original = db.migrations[index];
      db.migrations[index] = new FailingPhysicalMigration(original);
      try {
        await expect(runW3DevGate(db)).rejects.toThrow(
          'fault injection after partial W3 schema',
        );
      } finally {
        db.migrations[index] = original;
      }
      const [state] = await db.query(
        `SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='invoices' AND column_name='shipping_policy_version') AS invoice_column,
      to_regclass('public.delivery_consent_sessions') IS NOT NULL AS consent,
      to_regclass('public.w3_delivery_policy_versions') IS NOT NULL AS policy,
      to_regclass('public.warehouse_delivery_gate') IS NOT NULL AS physical,
      (SELECT count(*)::int FROM public.migrations WHERE name=ANY($1)) AS ledger,
      (SELECT count(*)::int FROM public.migrations WHERE name=ANY($2)) AS cash_ledger`,
        [W3_MIGRATIONS, CASH_MIGRATIONS],
      );
      expect(state).toEqual({
        invoice_column: false,
        consent: false,
        policy: false,
        physical: false,
        ledger: 0,
        cash_ledger: 0,
      });
    }, 30000);

    it.skipIf(!ZeroFeeOperations)(
      'rolls back additive 0008 and every W3 ledger row while the cash pair stays pending',
      async () => {
        const index = db.migrations.findIndex(
          (migration) => migration.name === W3_MIGRATIONS[4],
        );
        const original = db.migrations[index];
        db.migrations[index] = new FailingZeroFeeMigration(original);
        try {
          await expect(runW3DevGate(db)).rejects.toThrow(
            'fault injection after additive zero-fee schema',
          );
        } finally {
          db.migrations[index] = original;
        }
        const [state] = await db.query(
          `SELECT
          to_regclass('public.delivery_operation_evidence') IS NOT NULL AS evidence,
          to_regclass('public.delivery_shipping_proposals') IS NOT NULL AS proposal,
          (SELECT count(*)::int FROM public.migrations WHERE name=ANY($1)) AS ledger,
          (SELECT count(*)::int FROM public.migrations WHERE name=ANY($2)) AS cash_ledger`,
          [W3_MIGRATIONS, CASH_MIGRATIONS],
        );
        expect(state).toEqual({
          evidence: false,
          proposal: false,
          ledger: 0,
          cash_ledger: 0,
        });
      },
      30000,
    );

    it('rolls back 0009 lifecycle DDL and the entire pending chain on failure', async () => {
      const index = db.migrations.findIndex((m) => m.name === W3_MIGRATIONS[5]);
      const original = db.migrations[index];
      db.migrations[index] = {
        name: original.name,
        up: async (q) => {
          await original.up(q);
          throw new Error('fault after 0009 lifecycle DDL');
        },
        down: async (q) => original.down(q),
      };
      try {
        await expect(runW3DevGate(db)).rejects.toThrow(
          'fault after 0009 lifecycle DDL',
        );
      } finally {
        db.migrations[index] = original;
      }
      const [proof] = await db.query(
        `SELECT to_regclass('public.w3_delivery_policy_previews') AS previews,
        to_regprocedure('public.w3_policy_audit_immutable()') AS guard,
        (SELECT count(*)::int FROM public.migrations WHERE name=ANY($1)) AS ledger`,
        [W3_MIGRATIONS],
      );
      expect(proof).toEqual({ previews: null, guard: null, ledger: 0 });
    }, 30000);

    it('rolls back 0010 and the pending chain atomically on DDL failure', async () => {
      const index = db.migrations.findIndex((m) => m.name === W3_MIGRATIONS[6]);
      const original = db.migrations[index];
      db.migrations[index] = {
        name: original.name,
        up: async (q) => {
          await original.up(q);
          throw new Error('fault after 0010 DDL');
        },
        down: (q) => original.down(q),
      };
      try {
        await expect(runW3DevGate(db)).rejects.toThrow('fault after 0010 DDL');
      } finally {
        db.migrations[index] = original;
      }
      expect(
        (
          await db.query(
            `SELECT to_regclass('public.delivery_fee_terms') AS terms,
        (SELECT count(*)::int FROM public.migrations WHERE name=ANY($1)) AS ledger`,
            [W3_MIGRATIONS],
          )
        )[0],
      ).toEqual({ terms: null, ledger: 0 });
    }, 30000);

    it('rolls back 0011 and the pending chain atomically on DDL failure; empty down preserves 0010', async () => {
      const original = db.migrations.find((m) => m.name === W3_MIGRATIONS[7])!;
      const index = db.migrations.indexOf(original);
      db.migrations[index] = {
        name: original.name,
        up: async (q) => {
          await original.up(q);
          throw new Error('fault after 0011 DDL');
        },
        down: (q) => original.down(q),
      };
      try {
        await expect(runW3DevGate(db)).rejects.toThrow('fault after 0011 DDL');
      } finally {
        db.migrations[index] = original;
      }
      expect(
        (
          await db.query(
            "SELECT to_regclass('public.w3_order_commission_snapshots') AS c",
          )
        )[0].c,
      ).toBeNull();
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        for (const Migration of w3MigrationClasses)
          await new Migration().up(runner);
        await new W3DeductionPreparation1793466000012().down(runner);
        await original.down(runner);
        expect(
          (
            await runner.query(
              "SELECT to_regclass('public.delivery_fee_terms') AS terms,to_regclass('public.w3_order_commission_snapshots') AS c",
            )
          )[0],
        ).toMatchObject({ c: null });
        expect(
          (
            await runner.query(
              "SELECT to_regclass('public.delivery_fee_terms') AS terms",
            )
          )[0].terms,
        ).toBeTruthy();
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    }, 30000);

    it('rolls back 0012 together with pending migrations and refuses partial 0012 replay', async () => {
      const original = db.migrations.find((m) => m.name === W3_MIGRATIONS[8])!;
      const index = db.migrations.indexOf(original);
      db.migrations[index] = {
        name: original.name,
        down: (q) => original.down(q),
        up: async (q) => {
          await original.up(q);
          throw new Error('fault after 0012 DDL');
        },
      };
      try {
        await expect(runW3DevGate(db)).rejects.toThrow('fault after 0012 DDL');
      } finally {
        db.migrations[index] = original;
      }
      expect(
        (
          await db.query(
            "SELECT to_regclass('public.w3_deduction_preparations') AS d",
          )
        )[0].d,
      ).toBeNull();
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        for (const Migration of w3MigrationClasses)
          await new Migration().up(runner);
        await original.down(runner);
        expect(
          (
            await runner.query(
              "SELECT to_regclass('public.w3_order_commission_snapshots') AS c",
            )
          )[0].c,
        ).toBeTruthy();
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
      await db.query(
        'CREATE FUNCTION public.w3_finance_readiness(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$',
      );
      try {
        await expect(runW3DevGate(db)).rejects.toThrow('refusing DDL replay');
      } finally {
        await db.query('DROP FUNCTION public.w3_finance_readiness(uuid)');
      }
    }, 30000);

    it('rolls back 0013 with its ledger and refuses an unledgered config row', async () => {
      const original = db.migrations.find(m => m.name === 'W3ShippingSafetyCap1793466000013')!;
      const index = db.migrations.indexOf(original);
      db.migrations[index] = { name: original.name, down: q => original.down(q), up: async q => {
        await original.up(q); throw new Error('fault after 0013 config');
      } };
      try { await expect(runW3DevGate(db)).rejects.toThrow('fault after 0013 config'); }
      finally { db.migrations[index] = original; }
      expect(await db.query("SELECT key FROM system_configs WHERE key='w3.shipping.max_new_fee_vnd'")).toEqual([]);
      expect((await db.query('SELECT count(*)::int AS n FROM migrations WHERE name=ANY($1)', [W3_MIGRATIONS]))[0].n).toBe(0);
      await db.query("INSERT INTO system_configs(key,value,value_type) VALUES ('w3.shipping.max_new_fee_vnd','17','int')");
      try { await expect(runW3DevGate(db)).rejects.toThrow('refusing DDL replay'); }
      finally { await db.query("DELETE FROM system_configs WHERE key='w3.shipping.max_new_fee_vnd'"); }
    }, 30000);

    it('0004 rejects a correctly split W3 invoice INSERT by its closed CHECK, while legacy positive shipping inserts', async () => {
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await new WarehouseDeliverySplit1793466000004().up(runner);
        const insert = `INSERT INTO public.invoices(service_order_id,labor_total,parts_total,
          fixhome_parts_total,technician_parts_total,technician_part_warranty_fee_total,
          shipping_fee,grand_total,commission_base,commission_rate_snapshot,commission_amount,
          shipping_policy_version,customer_shipping_share,technician_shipping_share)
          VALUES ($1,200000,0,0,0,0,30000,$2,200000,0.1,20000,$3,$4,$5)`;
        await runner.query(insert, [randomUUID(), 230000, 'LEGACY_100_0', 30000, 0]);
        await expect(
          runner.query(insert, [randomUUID(), 221000, 'W3_70_30_V1', 21000, 9000]),
        ).rejects.toMatchObject({
          driverError: { code: '23514', constraint: 'ck_invoice_shipping_cutover_closed' },
        });
      } finally {
        // Includes the migration and accepted legacy row; never persists test invoices.
        await runner.rollbackTransaction();
        await runner.release();
      }
    });

    it('applies the exact W3 order once, keeps legacy invoices closed and replays without DDL', async () => {
      const invoiceId = randomUUID();
      await db.query(
        `INSERT INTO public.invoices(id,service_order_id,labor_total,parts_total,
      fixhome_parts_total,technician_parts_total,technician_part_warranty_fee_total,shipping_fee,
      grand_total,commission_base,commission_rate_snapshot,commission_amount)
      VALUES ($1,$2,100000,0,0,0,0,20000,120000,10000,0.1,10000)`,
        [invoiceId, randomUUID()],
      );

      // Explicit default role grants survive REVOKE FROM PUBLIC; 0010 must revoke each role.
      await db.query(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role',
      );
      try {
        expect(await runW3DevGate(db)).toEqual([...W3_MIGRATIONS]);
        expect(await db.query("SELECT value,value_type,description FROM system_configs WHERE key='w3.shipping.max_new_fee_vnd'"))
          .toEqual([{ value: '0', value_type: 'int', description: 'Trần phí giao W3 mới (₫); 0 = chặn phí dương mới, không xóa nghĩa vụ phí thực tế hay mở thanh toán.' }]);
      } finally {
        await db.query(
          'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon,authenticated,service_role',
        );
      }
      const [cashState] = await db.query(
        `SELECT count(*)::int AS n FROM public.migrations WHERE name=ANY($1)`,
        [CASH_MIGRATIONS],
      );
      expect(
        cashState.n,
        'the unchanged cash gate must still own the pending cash pair',
      ).toBe(0);
      const [invoice] = await db.query(
        `SELECT shipping_policy_version,customer_shipping_share,
      technician_shipping_share FROM public.invoices WHERE id=$1`,
        [invoiceId],
      );
      expect(invoice).toMatchObject({
        shipping_policy_version: 'LEGACY_100_0',
        customer_shipping_share: null,
        technician_shipping_share: null,
      });
      await expect(
        db.query('UPDATE public.invoices SET shipping_fee=30000 WHERE id=$1', [
          invoiceId,
        ]),
      ).rejects.toThrow('Invoice financial snapshot is immutable');

      const downs = db.migrations.map((migration) => migration.down);
      try {
        for (const migration of db.migrations) {
          migration.down = async () => {
            throw new Error('down must never run');
          };
        }
        expect(await runW3DevGate(db)).toEqual([]);
      } finally {
        db.migrations.forEach((migration, index) => {
          migration.down = downs[index];
        });
      }
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM public.migrations WHERE name=ANY($1)',
            [W3_MIGRATIONS],
          )
        )[0].n,
      ).toBe(W3_MIGRATIONS.length);
      for (const table of [
        'delivery_consent_sessions',
        'delivery_consent_commands',
        'delivery_evidence_records',
        'w3_delivery_policy_versions',
        'w3_delivery_policy_previews',
        'warehouse_delivery_gate',
        'warehouse_delivery_cohorts',
        'warehouse_delivery_events',
        'warehouse_delivery_movements',
        'delivery_operation_evidence',
        'delivery_shipping_proposals',
        'delivery_fee_terms',
      ]) {
        const [rls] = await db.query(
          'SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass($1)',
          [`public.${table}`],
        );
        expect(rls.relrowsecurity, table).toBe(true);
      }
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const [access] = await db.query(
          "SELECT has_table_privilege($1,'public.delivery_consent_sessions','SELECT') AS allowed",
          [role],
        );
        expect(access.allowed, role).toBe(false);
      }
      const [gate] = await db.query(
        'SELECT enabled FROM public.warehouse_delivery_gate',
      );
      expect(gate.enabled).toBe(false);

      const zeroFeeTriggers: Array<[string, string]> = [
        ['delivery_operation_evidence', 'w3_live_evidence_guard'],
        ['delivery_operation_evidence', 'w3_live_immutable'],
        ['delivery_operation_evidence', 'w3_live_no_truncate'],
        ['delivery_shipping_proposals', 'w3_live_proposal_guard'],
        ['delivery_shipping_proposals', 'w3_live_immutable'],
        ['delivery_shipping_proposals', 'w3_live_no_truncate'],
        ['warehouse_delivery_events', 'guard_w3_delivery_event'],
        ['warehouse_delivery_events', 'w3_live_event_complete'],
        ['warehouse_delivery_movements', 'guard_w3_delivery_movement'],
        ['part_requests', 'w3_live_request_guard'],
        ['part_request_items', 'w3_live_item_guard'],
        ['invoices', 'w3_live_invoice_guard'],
        ['service_orders', 'w3_live_order_guard'],
        ['technician_assignments', 'w3_live_assignment_guard'],
        ['additional_cost_requests', 'w3_live_source_guard'],
        ['additional_cost_items', 'w3_live_source_items_guard'],
        ['warehouses', 'w3_live_warehouse_guard'],
      ];
      for (const [table, trigger] of zeroFeeTriggers) {
        const [row] = await db.query(
          `SELECT tgenabled AS enabled FROM pg_trigger
          WHERE tgrelid=to_regclass($1) AND tgname=$2`,
          [`public.${table}`, trigger],
        );
        expect(row?.enabled, `${table}.${trigger}`).toBe('O');
      }
      const [zeroFeeGuards] = await db.query(`SELECT
        (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='guard_w3_delivery_event') AS event_guard,
        (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='guard_w3_delivery_event_closed') AS event_closed,
        (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='guard_w3_delivery_movement') AS movement_guard,
        (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='guard_w3_delivery_movement_closed') AS movement_closed`);
      expect(zeroFeeGuards.event_guard).toContain(
        'delivery_shipping_proposals',
      );
      expect(zeroFeeGuards.event_closed).not.toContain(
        'delivery_shipping_proposals',
      );
      expect(zeroFeeGuards.movement_guard).toContain('warehouse_stock');
      expect(zeroFeeGuards.movement_closed).not.toContain('warehouse_stock');
    }, 30000);

    it('checks cap configuration, preserves Admin changes on replay and refuses down after audit', async () => {
      for (const value of ['-1', '1.5', '100000001', '20000x']) {
        await db.query("UPDATE system_configs SET value=$1 WHERE key='w3.shipping.max_new_fee_vnd'", [value]);
        await expect(runW3DevGate(db)).rejects.toThrow('W3 shipping safety cap missing or invalid');
      }
      await db.query("UPDATE system_configs SET value='17' WHERE key='w3.shipping.max_new_fee_vnd'");
      expect(await runW3DevGate(db)).toEqual([]);
      expect((await db.query("SELECT value FROM system_configs WHERE key='w3.shipping.max_new_fee_vnd'"))[0].value).toBe('17');
      const migration = new W3ShippingSafetyCap1793466000013();
      const q = db.createQueryRunner();
      await q.connect();
      try {
        await expect(migration.down(q)).rejects.toThrow('has history');
        await db.query("UPDATE system_configs SET value='0' WHERE key='w3.shipping.max_new_fee_vnd'");
        await db.query("INSERT INTO audit_logs(resource_type,resource_id) VALUES ('system_config','w3.shipping.max_new_fee_vnd')");
        await expect(migration.down(q)).rejects.toThrow('has history');
        await db.query("DELETE FROM audit_logs WHERE resource_type='system_config' AND resource_id='w3.shipping.max_new_fee_vnd'");
        await q.startTransaction();
        await migration.down(q);
        await q.commitTransaction();
        await expect(runW3DevGate(db)).rejects.toThrow('W3 shipping safety cap missing or invalid');
        await migration.up(q);
      } finally {
        if (q.isTransactionActive) await q.rollbackTransaction();
        await q.release();
      }
      expect(await runW3DevGate(db)).toEqual([]);
    }, 30000);

    it('refuses an unknown pending migration without running it', async () => {
      class Unexpected1793466000010 implements MigrationInterface {
        name = 'Unexpected1793466000010';
        async up(_queryRunner: QueryRunner) {
          throw new Error('must never execute');
        }
        async down(_queryRunner: QueryRunner) {
          throw new Error('must never execute');
        }
      }
      db.migrations.push(new Unexpected1793466000010());
      try {
        await expect(runW3DevGate(db)).rejects.toThrow(
          'Unexpected pending migration',
        );
      } finally {
        db.migrations.pop();
      }
    });

    it('refuses a missing schema object after the ledger says applied', async () => {
      await db.query('DROP INDEX public.uq_delivery_proposal_version');
      await expect(runW3DevGate(db)).rejects.toThrow(
        'W3 delivery consent unique index missing',
      );
      await db.query(`CREATE UNIQUE INDEX uq_delivery_proposal_version
      ON public.delivery_consent_commands(part_request_id,quote_version)
      WHERE kind IN ('PROPOSE','REVISE')`);
      expect(await runW3DevGate(db)).toEqual([]);
    });

    it('refuses a Data API role grant on a private W3 table', async () => {
      await db.query(
        'GRANT SELECT ON public.delivery_consent_sessions TO anon',
      );
      await expect(runW3DevGate(db)).rejects.toThrow(
        'Data API role has W3 private table access',
      );
      await db.query(
        'REVOKE SELECT ON public.delivery_consent_sessions FROM anon',
      );
    });

    it('refuses a database role without protected migration authority', async () => {
      const role = `w3_gate_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const password = `pw_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      const limited = await new DataSource({
        ...connection,
        username: role,
        password,
        database,
        migrations: [],
      }).initialize();
      try {
        await expect(runW3DevGate(limited)).rejects.toThrow(
          'unsafe for protected W3 DEV migration',
        );
      } finally {
        if (limited.isInitialized) await limited.destroy();
        await admin.query(`DROP ROLE "${role}"`);
      }
    });

    it('rejects non-prefix W3 ledger loss before attempting DDL replay', async () => {
      await db.query('DELETE FROM public.migrations WHERE name=$1', [
        W3_MIGRATIONS[3],
      ]);
      await expect(runW3DevGate(db)).rejects.toThrow(
        'W3 migration ledger order is invalid',
      );
      expect(
        (
          await db.query(
            "SELECT to_regclass('public.warehouse_delivery_gate') AS present",
          )
        )[0].present,
      ).toBeTruthy();
      await db.query(
        'INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)',
        [Number(W3_MIGRATIONS[3].slice(-13)), W3_MIGRATIONS[3]],
      );
      expect(await runW3DevGate(db)).toEqual([]);
    });

    it('refuses 0009 replay and detects missing preview protections and API grants', async () => {
      await db.query('DELETE FROM public.migrations WHERE name=ANY($1)', [
        W3_MIGRATIONS.slice(5),
      ]);
      // The 0006 DRAFT-only schema proof fails before any DDL replay marker is consulted.
      await expect(runW3DevGate(db)).rejects.toThrow(
        'W3 delivery policy schema proof incomplete',
      );
      for (const name of W3_MIGRATIONS.slice(5))
        await db.query(
          'INSERT INTO public.migrations(timestamp,name) VALUES($1,$2)',
          [Number(name.slice(-13)), name],
        );
      await db.query(
        'ALTER TABLE public.w3_delivery_policy_previews DISABLE TRIGGER w3_policy_previews_immutable',
      );
      await expect(runW3DevGate(db)).rejects.toThrow(
        'W3 operating lifecycle trigger missing',
      );
      await db.query(
        'ALTER TABLE public.w3_delivery_policy_previews ENABLE TRIGGER w3_policy_previews_immutable',
      );
      await db.query(
        'GRANT SELECT ON public.w3_delivery_policy_previews TO anon',
      );
      await expect(runW3DevGate(db)).rejects.toThrow(
        'Data API role has W3 private table access',
      );
      await db.query(
        'REVOKE SELECT ON public.w3_delivery_policy_previews FROM anon',
      );
      await db.query(
        'GRANT EXECUTE ON FUNCTION public.w3_delivery_policy_preview_guard() TO authenticated',
      );
      await expect(runW3DevGate(db)).rejects.toThrow(
        'Data API role can execute W3 operating lifecycle function',
      );
      await db.query(
        'REVOKE EXECUTE ON FUNCTION public.w3_delivery_policy_preview_guard() FROM authenticated',
      );
      expect(await runW3DevGate(db)).toEqual([]);
    });

    it.each(['PUBLIC', 'anon', 'authenticated', 'service_role'])(
      'refuses every 0012 table privilege and function EXECUTE granted to %s',
      async (role) => {
        for (const privilege of [
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
          'REFERENCES',
          'TRIGGER',
        ]) {
          await db.query(
            `GRANT ${privilege} ON public.w3_deduction_preparations TO ${role}`,
          );
          try {
            await expect(runW3DevGate(db)).rejects.toThrow(
              /deduction preparation/i,
            );
          } finally {
            await db.query(
              `REVOKE ${privilege} ON public.w3_deduction_preparations FROM ${role}`,
            );
          }
        }
        for (const fn of [
          'w3_finance_readiness(uuid)',
          'w3_deduction_preparation_guard()',
        ]) {
          await db.query(`GRANT EXECUTE ON FUNCTION public.${fn} TO ${role}`);
          try {
            await expect(runW3DevGate(db)).rejects.toThrow(
              /deduction preparation/i,
            );
          } finally {
            await db.query(
              `REVOKE EXECUTE ON FUNCTION public.${fn} FROM ${role}`,
            );
          }
        }
        expect(await runW3DevGate(db)).toEqual([]);
      },
      30000,
    );

    it('rejects 0012 disabled guards, RLS drift, policies and column grants', async () => {
      for (const trigger of [
        'w3_d_preparation_guard',
        'w3_d_preparation_immutable',
        'w3_d_preparation_no_truncate',
      ]) {
        await db.query(
          `ALTER TABLE public.w3_deduction_preparations DISABLE TRIGGER ${trigger}`,
        );
        try {
          await expect(runW3DevGate(db)).rejects.toThrow(
            /deduction preparation/i,
          );
        } finally {
          await db.query(
            `ALTER TABLE public.w3_deduction_preparations ENABLE TRIGGER ${trigger}`,
          );
        }
      }
      await db.query(
        'ALTER TABLE public.w3_deduction_preparations DISABLE ROW LEVEL SECURITY',
      );
      try {
        await expect(runW3DevGate(db)).rejects.toThrow(
          /deduction preparation/i,
        );
      } finally {
        await db.query(
          'ALTER TABLE public.w3_deduction_preparations ENABLE ROW LEVEL SECURITY',
        );
      }
      await db.query(
        'CREATE POLICY unexpected ON public.w3_deduction_preparations USING (true)',
      );
      try {
        await expect(runW3DevGate(db)).rejects.toThrow(
          /deduction preparation/i,
        );
      } finally {
        await db.query(
          'DROP POLICY unexpected ON public.w3_deduction_preparations',
        );
      }
      await db.query(
        'GRANT SELECT(statement_ref) ON public.w3_deduction_preparations TO authenticated',
      );
      try {
        await expect(runW3DevGate(db)).rejects.toThrow(
          /deduction preparation/i,
        );
      } finally {
        await db.query(
          'REVOKE SELECT(statement_ref) ON public.w3_deduction_preparations FROM authenticated',
        );
      }
      expect(await runW3DevGate(db)).toEqual([]);
    }, 30000);

    it.each(['anon', 'authenticated', 'service_role'])(
      'denies actual SQL access to 0012 evidence and diagnostics for %s',
      async (role) => {
        const runner = db.createQueryRunner();
        await runner.connect();
        try {
          for (const sql of [
            'SELECT * FROM public.w3_deduction_preparations',
            'INSERT INTO public.w3_deduction_preparations DEFAULT VALUES',
            'SELECT public.w3_finance_readiness(NULL::uuid)',
          ]) {
            await runner.startTransaction();
            await runner.query(`SET LOCAL ROLE ${role}`);
            await expect(runner.query(sql)).rejects.toThrow(
              'permission denied',
            );
            await runner.rollbackTransaction();
          }
        } finally {
          if (runner.isTransactionActive) await runner.rollbackTransaction();
          await runner.release();
        }
      },
    );

    it('refuses 0011 replay, disabled guards, function grants and private table grants', async () => {
      await db.query('DELETE FROM public.migrations WHERE name=ANY($1)', [
        W3_MIGRATIONS.slice(7),
      ]);
      await expect(runW3DevGate(db)).rejects.toThrow('refusing DDL replay');
      for (const name of W3_MIGRATIONS.slice(7))
        await db.query(
          'INSERT INTO public.migrations(timestamp,name) VALUES($1,$2)',
          [Number(name.slice(-13)), name],
        );
      await db.query(
        'ALTER TABLE public.delivery_fee_terms DISABLE TRIGGER w3_fee_terms_zz_commission',
      );
      await expect(runW3DevGate(db)).rejects.toThrow(
        'prequote commission schema proof incomplete',
      );
      await db.query(
        'ALTER TABLE public.delivery_fee_terms ENABLE TRIGGER w3_fee_terms_zz_commission',
      );
      await db.query(
        'GRANT EXECUTE ON FUNCTION public.w3_approved_labor_source(uuid) TO anon',
      );
      await expect(runW3DevGate(db)).rejects.toThrow(
        'Data API role can execute W3 prequote commission function',
      );
      await db.query(
        'REVOKE EXECUTE ON FUNCTION public.w3_approved_labor_source(uuid) FROM anon',
      );
      await db.query(
        'GRANT SELECT ON public.w3_order_commission_snapshots TO authenticated',
      );
      await expect(runW3DevGate(db)).rejects.toThrow(
        'Data API role has W3 private table access',
      );
      await db.query(
        'REVOKE SELECT ON public.w3_order_commission_snapshots FROM authenticated',
      );
      expect(await runW3DevGate(db)).toEqual([]);
    });

    it.each(
      ['PUBLIC', 'anon', 'authenticated', 'service_role'].flatMap((grantee) =>
        ['USAGE', 'SELECT', 'UPDATE'].map((privilege) => ({
          grantee,
          privilege,
        })),
      ),
    )(
      'rejects $grantee $privilege on the commission sequence and passes after revocation',
      async ({ grantee, privilege }) => {
        const sequence = 'public.w3_commission_config_versions_revision_seq';
        expect(await runW3DevGate(db)).toEqual([]);
        await db.query(
          `GRANT ${privilege} ON SEQUENCE ${sequence} TO ${grantee}`,
        );
        try {
          if (grantee !== 'PUBLIC') {
            const [effective] = await db.query(
              'SELECT has_sequence_privilege($1,$2,$3) AS allowed',
              [grantee, sequence, privilege],
            );
            expect(effective.allowed).toBe(true);
          }
          await expect(runW3DevGate(db)).rejects.toThrow(
            grantee === 'PUBLIC'
              ? 'W3 prequote commission sequence ACL incomplete'
              : 'Data API role has W3 prequote commission sequence access',
          );
        } finally {
          await db.query(
            `REVOKE ${privilege} ON SEQUENCE ${sequence} FROM ${grantee}`,
          );
        }
        expect(await runW3DevGate(db)).toEqual([]);
      },
    );

    it('refuses 0010 DDL replay, disabled protections and API grants', async () => {
      await db.query('DELETE FROM public.migrations WHERE name=ANY($1)', [
        W3_MIGRATIONS.slice(6),
      ]);
      await expect(runW3DevGate(db)).rejects.toThrow('refusing DDL replay');
      for (const name of W3_MIGRATIONS.slice(6))
        await db.query(
          'INSERT INTO public.migrations(timestamp,name) VALUES($1,$2)',
          [Number(name.slice(-13)), name],
        );
      await db.query(
        'ALTER TABLE public.delivery_fee_terms DISABLE TRIGGER w3_fee_terms_immutable',
      );
      await expect(runW3DevGate(db)).rejects.toThrow(
        'conditional fee terms schema proof incomplete',
      );
      await db.query(
        'ALTER TABLE public.delivery_fee_terms ENABLE TRIGGER w3_fee_terms_immutable',
      );
      await db.query('GRANT SELECT ON public.delivery_fee_terms TO anon');
      await expect(runW3DevGate(db)).rejects.toThrow(
        'Data API role has W3 private table access',
      );
      await db.query('REVOKE SELECT ON public.delivery_fee_terms FROM anon');
      expect(await runW3DevGate(db)).toEqual([]);
    });

    it.skipIf(!ZeroFeeOperations)(
      'refuses non-prefix 0008 and 0009 ledger loss before any replay',
      async () => {
        await db.query('DELETE FROM public.migrations WHERE name=ANY($1)', [
          W3_MIGRATIONS.slice(4),
        ]);
        await expect(runW3DevGate(db)).rejects.toThrow(
          'W3 delivery policy schema proof incomplete',
        );
        expect(
          (
            await db.query(
              "SELECT to_regclass('public.delivery_shipping_proposals') AS present",
            )
          )[0].present,
        ).toBeTruthy();
        for (const name of W3_MIGRATIONS.slice(4))
          await db.query(
            'INSERT INTO public.migrations(timestamp,name) VALUES ($1,$2)',
            [Number(name.slice(-13)), name],
          );
        expect(await runW3DevGate(db)).toEqual([]);
      },
    );

    it('admits 0014/0015 and proves the positive bridge and invoice cutover guards', async () => {
      const [bridge] = await db.query(`SELECT
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
          AND table_name='warehouse_delivery_events' AND column_name='fee_terms_version'
          AND data_type='integer' AND is_nullable='YES') AS terms_column,
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid=to_regclass('public.warehouse_delivery_events')
            AND conname='fk_w3_physical_fee_terms' AND convalidated) AS terms_fk,
        to_regprocedure('public.w3_positive_physical_terms(uuid)') IS NOT NULL AS terms_function`);
      expect(bridge).toEqual({
        terms_column: true,
        terms_fk: true,
        terms_function: true,
      });

      const [cutover] = await db.query(`SELECT
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid=to_regclass('public.invoices')
            AND conname='ck_invoice_shipping_cutover_closed') AS legacy_closed,
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid=to_regclass('public.invoices')
            AND conname='ck_invoice_shipping_shares' AND convalidated
            AND pg_get_constraintdef(oid) LIKE '%W3_70_30_V1%') AS provenance_check,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.invoices')
          AND tgname='w3_invoice_provenance_immutable' AND tgenabled='O') AS provenance_trigger`);
      expect(cutover).toEqual({
        legacy_closed: false,
        provenance_check: true,
        provenance_trigger: true,
      });

      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        const [legacy] = await runner.query(
          `INSERT INTO public.invoices(id) VALUES($1)
          RETURNING shipping_policy_version,shipping_shipments`,
          [randomUUID()],
        );
        expect(legacy).toEqual({
          shipping_policy_version: 'LEGACY_100_0',
          shipping_shipments: null,
        });
        await expect(
          runner.query(
            `INSERT INTO public.invoices(service_order_id,shipping_policy_version,
            shipping_fee,customer_shipping_share,technician_shipping_share,shipping_shipments)
            VALUES($1,'W3_70_30_V1',1,1,0,'[{"partRequestId":"unsourced"}]'::jsonb)`,
            [randomUUID()],
          ),
        ).rejects.toThrow('W3_SOURCE_REQUIRED');
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    }, 30000);

    it('fails closed on missing 0014/0015 schema proof or a dirty ledger', async () => {
      await db.query(
        'ALTER TABLE public.warehouse_delivery_events DROP CONSTRAINT fk_w3_physical_fee_terms',
      );
      try {
        await expect(runW3DevGate(db)).rejects.toThrow(
          'W3 positive physical schema proof incomplete',
        );
      } finally {
        await db.query(`ALTER TABLE public.warehouse_delivery_events
          ADD CONSTRAINT fk_w3_physical_fee_terms
          FOREIGN KEY(part_request_id,fee_terms_version)
          REFERENCES public.delivery_fee_terms(part_request_id,result_version)`);
      }
      expect(await runW3DevGate(db)).toEqual([]);

      await db.query(
        'ALTER TABLE public.invoices DISABLE TRIGGER w3_invoice_provenance_immutable',
      );
      try {
        await expect(runW3DevGate(db)).rejects.toThrow(
          'W3 invoice payment enable schema proof incomplete',
        );
      } finally {
        await db.query(
          'ALTER TABLE public.invoices ENABLE TRIGGER w3_invoice_provenance_immutable',
        );
      }
      expect(await runW3DevGate(db)).toEqual([]);

      await db.query('DELETE FROM public.migrations WHERE name=$1', [
        W3_MIGRATIONS[10],
      ]);
      try {
        await expect(runW3DevGate(db)).rejects.toThrow(
          'W3 migration ledger order is invalid',
        );
      } finally {
        await db.query(
          'INSERT INTO public.migrations(timestamp,name) VALUES($1,$2)',
          [Number(W3_MIGRATIONS[10].slice(-13)), W3_MIGRATIONS[10]],
        );
      }
      expect(await runW3DevGate(db)).toEqual([]);

      await db.query('DELETE FROM public.migrations WHERE name=$1', [
        W3_MIGRATIONS[11],
      ]);
      try {
        await expect(runW3DevGate(db)).rejects.toThrow('refusing DDL replay');
      } finally {
        await db.query(
          'INSERT INTO public.migrations(timestamp,name) VALUES($1,$2)',
          [Number(W3_MIGRATIONS[11].slice(-13)), W3_MIGRATIONS[11]],
        );
      }
      expect(await runW3DevGate(db)).toEqual([]);
    }, 30000);

    it.skipIf(!ZeroFeeOperations)(
      'refuses a partial 0008 schema with missing 0008 and 0009 ledger',
      async () => {
        await db.query('DELETE FROM public.migrations WHERE name=ANY($1)', [
          W3_MIGRATIONS.slice(4),
        ]);
        await db.query(
          'DROP TABLE public.delivery_shipping_proposals, public.delivery_operation_evidence',
        );
        // The newer lifecycle schema is detected as inconsistent with the truncated ledger first.
        await expect(runW3DevGate(db)).rejects.toThrow(
          'W3 delivery policy schema proof incomplete',
        );
        expect(
          (
            await db.query(
              "SELECT to_regclass('public.delivery_operation_evidence') AS present",
            )
          )[0].present,
        ).toBeNull();
      },
    );
  },
);
