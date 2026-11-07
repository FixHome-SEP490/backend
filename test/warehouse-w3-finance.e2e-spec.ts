// Real existing CI PostgreSQL service only. Never consume dotenv / shared DATABASE_* settings.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { WarehouseDeliverySplit1793466000004 } from '../src/database/migrations/1793466000004-WarehouseDeliverySplit';

describe.skipIf(process.env.CI !== 'true')(
  'W3 immutable legacy invoice / closed cutover on real CI PostgreSQL',
  () => {
    const schema = `warehouse_w3_e2e_${randomUUID().replaceAll('-', '')}`;
    let root: DataSource,
      db: DataSource,
      historicalId: string,
      customerId: string,
      serviceId: string;
    const migration = new WarehouseDeliverySplit1793466000004();
    async function newOrder(): Promise<string> {
      const booking = await db
        .getRepository('Booking')
        .save({
          customerId,
          serviceId,
          description: 'W3 synthetic request',
          status: 'matched',
        });
      const order = await db
        .getRepository('ServiceOrder')
        .save({
          bookingId: booking.id,
          code: `W3-${randomUUID()}`,
          status: 'under_repair',
        });
      return order.id;
    }
    beforeAll(async () => {
      const connection = {
        type: 'postgres' as const,
        host: '127.0.0.1',
        port: 5432,
        username: 'postgres',
        password: 'postgres',
        database: 'fixhome',
        ssl: false,
        synchronize: false,
      };
      root = await new DataSource(connection).initialize();
      if (
        (await root.query('SELECT current_database() AS name'))[0].name !==
          'fixhome' ||
        !/^warehouse_w3_e2e_[a-f0-9]{32}$/.test(schema)
      )
        throw new Error('Wrong CI fixture');
      await root.query(
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public',
      );
      await root.query(`CREATE SCHEMA "${schema}"`);
      db = await new DataSource({
        ...connection,
        schema,
        extra: {
          options: `-c search_path=${schema},public -c lock_timeout=5000 -c statement_timeout=15000`,
        },
        entities: [resolve('dist/**/*.entity.js')],
        migrations: [resolve('dist/database/migrations/*.js')],
      }).initialize();
      // Test the historical 0004 upgrade, not today's live monetary cutover.
      // Later W3 migrations depend on 0004 and must not precede its explicit up().
      // The current 0014/0015 chain is exercised by the isolated release/physical gates.
      db.migrations.splice(
        0,
        db.migrations.length,
        ...db.migrations.filter(
          (m) =>
            Number(m.name!.slice(-13)) < 1793466000004 && ![
              'VoucherFundingLedger1792994400001',
              'VoucherCampaignLifecycle1793116800000',
              'CashPaymentIntents1793293200000',
              'TechnicianResponsibility1793293200001',
            ].includes(m.name),
        ),
      );
      await db.runMigrations();
      expect(await db.query(`SELECT 1 FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='invoices' AND column_name='shipping_policy_version'`, [schema])).toHaveLength(0);
      const save = (name: string, value: object) =>
        db.getRepository(name).save(value);
      const customer = await save('User', {
        email: `${randomUUID()}@example.test`,
        passwordHash: 'ci-no-login',
        fullName: 'W3 synthetic customer',
        role: 'customer',
        status: 'active',
        isActive: true,
      });
      const category = await save('ServiceCategory', {
        code: randomUUID(),
        name: 'W3 synthetic category',
      });
      const service = await save('Service', {
        categoryId: category.id,
        code: randomUUID(),
        name: 'W3 synthetic repair',
        pricingMode: 'fixed_price',
        fixedPrice: 100000,
      });
      customerId = customer.id;
      serviceId = service.id;
      // Insert using the real pre-W3 table contract, before adding the new columns.
      historicalId = (
        await db.query(
          `INSERT INTO invoices(service_order_id,labor_total,commission_amount,shipping_fee,grand_total)
      VALUES ($1,100000,10000,20000,120000) RETURNING id`,
          [await newOrder()],
        )
      )[0].id;
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await migration.up(runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    }, 60000);
    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (root?.isInitialized) {
        if (!/^warehouse_w3_e2e_[a-f0-9]{32}$/.test(schema))
          throw new Error('Unsafe fixture cleanup');
        await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await root.destroy();
      }
    });

    it('preserves historical money and nullable shares without backfill', async () => {
      expect(
        (
          await db.query(
            'SELECT grand_total,shipping_fee,shipping_policy_version,customer_shipping_share,technician_shipping_share FROM invoices WHERE id=$1',
            [historicalId],
          )
        )[0],
      ).toEqual({
        grand_total: '120000',
        shipping_fee: '20000',
        shipping_policy_version: 'LEGACY_100_0',
        customer_shipping_share: null,
        technician_shipping_share: null,
      });
    });
    it('permits payment lifecycle updates without changing financial snapshots', async () => {
      await db.query(
        "UPDATE invoices SET payment_status='paid',paid_at=now() WHERE id=$1",
        [historicalId],
      );
      expect(
        (
          await db.query(
            'SELECT grand_total,payment_status FROM invoices WHERE id=$1',
            [historicalId],
          )
        )[0],
      ).toEqual({ grand_total: '120000', payment_status: 'paid' });
    });
    it.each([
      'grand_total',
      'labor_total',
      'commission_amount',
      'shipping_fee',
    ])('rejects rewriting historical %s', async (column) => {
      await expect(
        db.query(`UPDATE invoices SET ${column}=${column}+1 WHERE id=$1`, [
          historicalId,
        ]),
      ).rejects.toThrow('immutable');
    });
    it('rejects backfilling old shares or deleting invoice history', async () => {
      await expect(
        db.query(
          'UPDATE invoices SET customer_shipping_share=20000,technician_shipping_share=0 WHERE id=$1',
          [historicalId],
        ),
      ).rejects.toThrow('immutable');
      await expect(
        db.query('DELETE FROM invoices WHERE id=$1', [historicalId]),
      ).rejects.toThrow('cannot be deleted');
    });
    it('accepts new complete legacy shares and refuses destructive downgrade afterwards', async () => {
      await db.query(
        `INSERT INTO invoices(service_order_id,shipping_fee,grand_total,customer_shipping_share,technician_shipping_share)
      VALUES ($1,20000,20000,20000,0)`,
        [await newOrder()],
      );
      const runner = db.createQueryRunner();
      await runner.connect();
      try {
        await expect(migration.down(runner)).rejects.toThrow(
          'Refusing to discard',
        );
      } finally {
        await runner.release();
      }
    });
    it('refuses a valid W3 split at the DB activation lock before any money can cut over', async () => {
      await expect(
        db.query(
          `INSERT INTO invoices(service_order_id,labor_total,commission_amount,shipping_fee,grand_total,
      shipping_policy_version,customer_shipping_share,technician_shipping_share)
      VALUES ($1,100000,10000,20000,114000,'W3_70_30_V1',14000,6000)`,
          [await newOrder()],
        ),
      ).rejects.toThrow('ck_invoice_shipping_cutover_closed');
    });
    it.each([
      [14000, 6000],
      [20000, null],
      [-1, 20001],
      [20001, -1],
    ])(
      'refuses inconsistent legacy shares %s/%s',
      async (customer, technician) => {
        await expect(
          db.query(
            `INSERT INTO invoices(service_order_id,shipping_fee,customer_shipping_share,technician_shipping_share)
      VALUES ($1,20000,$2,$3)`,
            [await newOrder(), customer, technician],
          ),
        ).rejects.toThrow('ck_invoice_shipping_shares');
      },
    );
  },
);
