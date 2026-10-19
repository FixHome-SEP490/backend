import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DataSource, QueryRunner } from 'typeorm';
import { CatalogV2VariantAndAlias1790000000037 } from '../../src/database/migrations/1790000000037-CatalogV2VariantAndAlias';
import { BookingDeviceAttributes1790000000038 } from '../../src/database/migrations/1790000000038-BookingDeviceAttributes';

const isolatedOptIn = process.env.FIXHOME_BOOKING_DEVICE_ATTRIBUTES_ISOLATED_TEST === 'YES';
const isolatedPort = Number(process.env.FIXHOME_BOOKING_DEVICE_ATTRIBUTES_ISOLATED_DB_PORT);
const pgIt = isolatedOptIn ? it : it.skip;
let dataSource: DataSource | undefined;

function assertExactLoopbackPostgresContainer(): void {
  if (!Number.isInteger(isolatedPort) || isolatedPort < 1024 || isolatedPort > 65535) {
    throw new Error('A valid isolated PostgreSQL loopback port is required');
  }

  const expectedContainerId = process.env.FIXHOME_BOOKING_DEVICE_ATTRIBUTES_ISOLATED_CONTAINER_ID;
  if (!expectedContainerId || !/^[a-f\d]{64}$/i.test(expectedContainerId)) {
    throw new Error('The full isolated PostgreSQL container ID is required');
  }

  const inspectFormat = '{{.Id}}|{{.State.Running}}|{{.Config.Image}}|{{range (index .NetworkSettings.Ports "5432/tcp")}}{{.HostIp}}|{{.HostPort}}{{end}}';
  const identity = execFileSync('docker', [
    'inspect', '--format', inspectFormat, expectedContainerId,
  ], { encoding: 'utf8', timeout: 5000 }).trim().split('|');
  const [actualId, running, image, hostIp, hostPort, unexpectedMapping] = identity;

  if (actualId?.toLowerCase() !== expectedContainerId.toLowerCase()
    || running !== 'true' || image !== 'postgres:16'
    || hostIp !== '127.0.0.1' || Number(hostPort) !== isolatedPort
    || unexpectedMapping !== undefined) {
    throw new Error('The exact running PostgreSQL 16 container must bind only the requested 127.0.0.1 port');
  }
}

beforeAll(async () => {
  if (!isolatedOptIn) return;
  assertExactLoopbackPostgresContainer();
  dataSource = new DataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port: isolatedPort,
    username: 'postgres',
    password: '',
    database: 'postgres',
    ssl: false,
    synchronize: false,
    entities: [],
    extra: { max: 5 },
  });
  await dataSource.initialize();
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('Booking device attributes rollback transaction safety', () => {
  it('requires an active transaction before issuing rollback SQL', async () => {
    const query = vi.fn(async () => []);
    const queryRunner = { isTransactionActive: false, query } as unknown as QueryRunner;

    await expect(new BookingDeviceAttributes1790000000038().down(queryRunner))
      .rejects.toThrow('active transaction');
    expect(query).not.toHaveBeenCalled();
  });

  it('locks bookings before checking for captured customer facts', async () => {
    const queries: string[] = [];
    const queryRunner = {
      isTransactionActive: true,
      query: vi.fn(async (sql: string) => { queries.push(sql); return []; }),
    } as unknown as QueryRunner;

    await new BookingDeviceAttributes1790000000038().down(queryRunner);

    expect(queries[0]).toMatch(/^\s*LOCK TABLE "bookings" IN ACCESS EXCLUSIVE MODE\s*$/i);
    expect(queries[1].toLowerCase()).toContain('do $booking_device_attributes_guard$ begin');
    expect(queries[2]).toMatch(/ALTER TABLE "bookings" DROP COLUMN IF EXISTS "device_attributes_snapshot"/i);
  });
});

describe('Booking device attributes additive migration', () => {
  pgIt('keeps legacy rows NULL and refuses to drop captured customer facts', async () => {
    if (!dataSource) throw new Error('Isolated PostgreSQL data source was not initialized');

    const schema = `catalog_v2_booking_${randomUUID().replaceAll('-', '')}`;
    const queryRunner = dataSource.createQueryRunner();
    let schemaCreated = false;
    try {
      await queryRunner.connect();
      await queryRunner.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      await queryRunner.query(`SET search_path TO "${schema}"`);
      await queryRunner.query('CREATE TABLE "bookings" ("id" integer PRIMARY KEY)');
      await queryRunner.query('INSERT INTO "bookings" ("id") VALUES (1)');

      const migration = new BookingDeviceAttributes1790000000038();
      await migration.up(queryRunner);
      await migration.up(queryRunner);
      const [legacyRow] = await queryRunner.query(
        'SELECT "device_attributes_snapshot" FROM "bookings" WHERE "id" = 1',
      );
      expect(legacyRow.device_attributes_snapshot).toBeNull();

      await queryRunner.query(`UPDATE "bookings" SET "device_attributes_snapshot" = '{"acHorsepower":"unknown"}'::jsonb WHERE "id" = 1`);
      await queryRunner.startTransaction();
      await expect(migration.down(queryRunner)).rejects.toThrow('refusing destructive rollback');
      await queryRunner.rollbackTransaction();
      const [preservedRow] = await queryRunner.query(
        'SELECT "device_attributes_snapshot" FROM "bookings" WHERE "id" = 1',
      );
      expect(preservedRow.device_attributes_snapshot).toEqual({ acHorsepower: 'unknown' });

      await queryRunner.query('UPDATE "bookings" SET "device_attributes_snapshot" = NULL WHERE "id" = 1');
      await queryRunner.startTransaction();
      await migration.down(queryRunner);
      await queryRunner.commitTransaction();
      const columns = await queryRunner.query(`
        SELECT attname FROM pg_attribute
        WHERE attrelid = $1::regclass
          AND attname = 'device_attributes_snapshot' AND NOT attisdropped
      `, [`"${schema}"."bookings"`]);
      expect(columns).toEqual([]);
    } finally {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      if (schemaCreated) await queryRunner.query(`DROP SCHEMA "${schema}" CASCADE`);
      if (queryRunner.isReleased === false) await queryRunner.release();
    }
  }, 15000);
});

async function waitForLockWait(observer: QueryRunner, backendPid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [activity] = await observer.query(`
      SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1
    `, [backendPid]);
    if (activity?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Rollback connection did not wait for the concurrent writer lock');
}

async function assertConcurrentRollbackPreservesData(options: {
  schemaSql: readonly string[];
  writerSql: string;
  verifySql: string;
  migration: { down(queryRunner: QueryRunner): Promise<void> };
}): Promise<void> {
  if (!dataSource) throw new Error('Isolated PostgreSQL data source was not initialized');

  const schema = `catalog_v2_rollback_${randomUUID().replaceAll('-', '')}`;
  const observer = dataSource.createQueryRunner();
  const writer = dataSource.createQueryRunner();
  const rollback = dataSource.createQueryRunner();
  let schemaCreated = false;

  try {
    await observer.connect();
    await observer.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await observer.query(`SET search_path TO "${schema}"`);
    for (const sql of options.schemaSql) await observer.query(sql);

    await writer.connect();
    await writer.query(`SET search_path TO "${schema}"`);
    await writer.startTransaction();
    await writer.query(options.writerSql);

    await rollback.connect();
    await rollback.query(`SET search_path TO "${schema}"`);
    await rollback.startTransaction();
    await rollback.query(`SET LOCAL lock_timeout = '8s'`);
    await rollback.query(`SET LOCAL statement_timeout = '10s'`);
    const [{ pid }] = await rollback.query('SELECT pg_backend_pid() AS pid');

    const downResult = options.migration.down(rollback).then(
      () => ({ completed: true as const }),
      (error: unknown) => ({ completed: false as const, error }),
    );
    await waitForLockWait(observer, Number(pid));
    await writer.commitTransaction();

    const result = await downResult;
    if (result.completed && rollback.isTransactionActive) await rollback.commitTransaction();
    else if (rollback.isTransactionActive) await rollback.rollbackTransaction();

    expect(result.completed).toBe(false);
    if ('error' in result) expect(String(result.error)).toContain('refusing destructive rollback');
    const preservedRows = await observer.query(options.verifySql);
    expect(preservedRows).toHaveLength(1);
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    if (rollback.isTransactionActive) await rollback.rollbackTransaction();
    if (schemaCreated) await observer.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (rollback.isReleased === false) await rollback.release();
    if (writer.isReleased === false) await writer.release();
    if (observer.isReleased === false) await observer.release();
  }
}

describe('Catalog V2 rollback race on isolated PostgreSQL 16', () => {
  pgIt('keeps concurrent inserts and updates when both guarded rollbacks race a writer', async () => {
    await assertConcurrentRollbackPreservesData({
      schemaSql: [
        'CREATE TABLE "service_price_variants" ("id" integer PRIMARY KEY)',
        'CREATE TABLE "service_code_aliases_v2" ("id" integer PRIMARY KEY)',
      ],
      writerSql: 'INSERT INTO "service_price_variants" ("id") VALUES (1)',
      verifySql: 'SELECT "id" FROM "service_price_variants" WHERE "id" = 1',
      migration: new CatalogV2VariantAndAlias1790000000037(),
    });

    await assertConcurrentRollbackPreservesData({
      schemaSql: [
        'CREATE TABLE "bookings" ("id" integer PRIMARY KEY, "device_attributes_snapshot" jsonb NULL)',
        'INSERT INTO "bookings" ("id") VALUES (1)',
      ],
      writerSql: `UPDATE "bookings" SET "device_attributes_snapshot" = '{"acHorsepower":"unknown"}'::jsonb WHERE "id" = 1`,
      verifySql: 'SELECT "device_attributes_snapshot" FROM "bookings" WHERE "id" = 1 AND "device_attributes_snapshot" IS NOT NULL',
      migration: new BookingDeviceAttributes1790000000038(),
    });
  }, 15000);
});
