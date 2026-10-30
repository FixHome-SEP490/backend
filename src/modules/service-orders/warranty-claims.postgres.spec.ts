import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DataSource, Table, TableForeignKey } from 'typeorm';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { Role, ServiceOrderStatus, WarrantyClaimStatus, WarrantyStatus } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';
import { CreateWarrantyClaimDto } from './dto/warranty-claim.dto';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import { WarrantyClaimsService } from './warranty-claims.service';
import { WarrantyNotifier } from './warranty-notifier.service';

// Vitest loads relation metadata; only the seven tables below are created.
// @ts-ignore import.meta.glob is transformed by Vitest, not the CommonJS backend.
const entityModules = import.meta.glob('../../**/*.entity.ts', { eager: true });

// Opt in with WARRANTY_CLAIMS_ISOLATED_PG=1. Never reads dotenv/DB configuration.
// This verifies real service/repositories, FK locks and durable notifications on PG16;
// it does not rehearse migrations, RLS, HTTP/JWT or the realtime listener.
describe.skipIf(process.env.WARRANTY_CLAIMS_ISOLATED_PG !== '1')('warranty claims isolated PostgreSQL 16', () => {
  const container = `fixhome_warranty_qa_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  let created = false;
  let observer: DataSource;
  const writers: DataSource[] = [];
  let services: WarrantyClaimsService[];
  let notifications: NotificationsService;
  const committedBeforeNotice: number[] = [];

  function docker(...args: string[]) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (result.status !== 0) throw new Error(`Isolated warranty PostgreSQL Docker ${args[0]} failed; no external fallback`);
    return result.stdout.trim();
  }

  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for PostgreSQL lock contention');
  }

  async function waitingWriters(count: number) {
    await until(async () => {
      const [row] = await observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='warranty_race_writer'
        AND state='active' AND wait_event_type='Lock'`);
      return row.n >= count;
    });
  }

  beforeAll(async () => {
    docker('run', '--detach', '--name', container, '--label', 'fixhome.qa=warranty-claims',
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=warranty_claims_qa',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    created = true;
    const ports = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', container));
    expect(ports['5432/tcp']).toHaveLength(1);
    expect(ports['5432/tcp'][0].HostIp).toBe('127.0.0.1');
    const options = {
      type: 'postgres' as const, host: '127.0.0.1', port: Number(ports['5432/tcp'][0].HostPort),
      username: 'postgres', password, database: 'warranty_claims_qa', ssl: false,
      entities: [...new Set(Object.values(entityModules)
        .flatMap(module => Object.values(module as Record<string, unknown>))
        .filter((value): value is new () => object => typeof value === 'function'))],
      synchronize: false, logging: false,
    };
    observer = new DataSource({ ...options, extra: { max: 5, application_name: 'warranty_qa_observer' } });
    await until(async () => {
      try {
        if (!observer.isInitialized) await observer.initialize();
        await observer.query('SELECT 1');
        return true;
      } catch {
        if (observer.isInitialized) await observer.destroy();
        return false;
      }
    });
    const [identity] = await observer.query(`SELECT current_database() AS name,
      current_setting('server_version_num')::int AS version`);
    expect(identity.name).toBe('warranty_claims_qa');
    expect(identity.version).toBeGreaterThanOrEqual(160000);
    expect(identity.version).toBeLessThan(170000);

    // Disposable fixture DDL from current entities, synchronize stays OFF. No migration run.
    const runner = observer.createQueryRunner();
    try {
      for (const entity of [User, Booking, ServiceOrder, TechnicianAssignment, WarrantyCoverage, WarrantyClaim, Notification]) {
        await runner.createTable(Table.create(observer.getMetadata(entity), observer.driver));
      }
      // In particular retain the real claim -> coverage FK: it participates in INSERT locking.
      for (const entity of [TechnicianAssignment, WarrantyClaim, Notification]) {
        const metadata = observer.getMetadata(entity);
        await runner.createForeignKeys(metadata.tableName,
          metadata.foreignKeys.map(key => TableForeignKey.create(key, observer.driver)));
      }
      // Fail at COMMIT (after save succeeds), to detect notifications emitted too early.
      await runner.query(`CREATE FUNCTION qa_reject_claim_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.description = 'QA reject commit' THEN RAISE EXCEPTION 'QA commit rejected'; END IF;
        RETURN NEW; END $$;
        CREATE CONSTRAINT TRIGGER qa_claim_commit AFTER INSERT ON warranty_claims
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qa_reject_claim_commit()`);
    } finally {
      await runner.release();
    }
    notifications = new NotificationsService(observer.getRepository(Notification));
    const createNotice = notifications.createNotification.bind(notifications);
    vi.spyOn(notifications, 'createNotification').mockImplementation(async params => {
      // This connection cannot see an uncommitted claim from either service instance.
      committedBeforeNotice.push(await observer.getRepository(WarrantyClaim).countBy({ serviceOrderId: params.referenceId }));
      return createNotice(params);
    });
    const notifier = new WarrantyNotifier(observer.getRepository(User), notifications);
    for (let i = 0; i < 2; i++) {
      const db = new DataSource({ ...options, extra: { max: 3, application_name: 'warranty_race_writer',
        options: '-c lock_timeout=8000 -c statement_timeout=10000' } });
      await db.initialize();
      writers.push(db);
    }
    services = writers.map(db => new WarrantyClaimsService(db, db.getRepository(WarrantyClaim), {} as never, notifier));
  }, 60000);

  afterEach(() => { committedBeforeNotice.length = 0; });
  afterAll(async () => {
    for (const db of writers) if (db.isInitialized) await db.destroy();
    if (observer?.isInitialized) await observer.destroy();
    if (created) {
      expect(docker('inspect', '--format', '{{index .Config.Labels "fixhome.qa"}}', container)).toBe('warranty-claims');
      docker('rm', '--force', container);
    }
  }, 30000);

  async function fixture(coverageCount = 1) {
    const customer = { id: randomUUID(), role: Role.CUSTOMER };
    const technicianId = randomUUID();
    await observer.getRepository(User).save([
      { id: customer.id, email: `${customer.id}@example.test`, fullName: 'QA customer', role: Role.CUSTOMER },
      { id: technicianId, email: `${technicianId}@example.test`, fullName: 'QA technician', role: Role.TECHNICIAN },
    ]);
    const booking = await observer.getRepository(Booking).save({ customerId: customer.id,
      serviceId: randomUUID(), description: 'Synthetic warranty test' });
    const order = await observer.getRepository(ServiceOrder).save({ bookingId: booking.id,
      code: `QA-${randomUUID()}`, status: ServiceOrderStatus.COMPLETED });
    await observer.getRepository(TechnicianAssignment).save({ serviceOrderId: order.id, technicianId });
    const coverages = await observer.getRepository(WarrantyCoverage).save(Array.from({ length: coverageCount }, () => ({
      serviceOrderId: order.id, expiresAt: new Date(Date.now() + 86400000), status: WarrantyStatus.ACTIVE,
    })));
    const dto = (index = 0): CreateWarrantyClaimDto => ({ warrantyCoverageId: coverages[index].id,
      description: 'Thiết bị lại gặp lỗi sau khi sửa chữa' });
    return { customer, technicianId, order, coverages, dto };
  }

  const counts = async (orderId: string) => ({
    claims: await observer.getRepository(WarrantyClaim).countBy({ serviceOrderId: orderId }),
    notices: await observer.getRepository(Notification).countBy({ referenceId: orderId }),
  });

  async function race(f: Awaited<ReturnType<typeof fixture>>) {
    const blocker = observer.createQueryRunner();
    await blocker.startTransaction();
    let results: ReturnType<typeof Promise.allSettled>;
    try {
      await blocker.manager.findOneOrFail(WarrantyCoverage, { where: { id: f.coverages[0].id },
        lock: { mode: 'pessimistic_write' } });
      results = Promise.allSettled(services.map(service => service.create(f.order.id, f.dto(), f.customer)));
      // Before the fix both INSERTs wait on the FK; after it both wait on the coverage SELECT.
      await waitingWriters(2);
    } finally {
      await blocker.rollbackTransaction();
      await blocker.release();
      if (results) await results;
    }
    return results;
  }

  function oneWinner(results: PromiseSettledResult<unknown>[]) {
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ status: 409, response: { code: ErrorCodes.CONFLICT } });
  }

  it('serializes two instances on the SAME coverage: one claim, one 409, one notification after commit; retry does not duplicate', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const f = await fixture();
      const results = await race(f);
      // Assert durable effects first so RED reports the actual duplicate insertion.
      expect(await counts(f.order.id)).toEqual({ claims: 1, notices: 1 });
      oneWinner(results);
      expect(committedBeforeNotice).toEqual([1]);
      const [notice] = await observer.getRepository(Notification).findBy({ referenceId: f.order.id });
      expect(notice).toMatchObject({ userId: f.technicianId, type: 'WARRANTY_CLAIM_SUBMITTED', referenceType: 'SERVICE_ORDER' });
      await expect(services[0].create(f.order.id, f.dto(), f.customer)).rejects.toMatchObject({ status: 409 });
      expect(await counts(f.order.id)).toEqual({ claims: 1, notices: 1 });
      committedBeforeNotice.length = 0;
    }
  }, 20000);

  it('does not block a DIFFERENT coverage on the same order while the first coverage is locked', async () => {
    const f = await fixture(2);
    const blocker = observer.createQueryRunner();
    await blocker.startTransaction();
    let pending: PromiseSettledResult<unknown>[];
    let first: Promise<PromiseSettledResult<unknown>[]>;
    try {
      await blocker.manager.findOneOrFail(WarrantyCoverage, { where: { id: f.coverages[0].id }, lock: { mode: 'pessimistic_write' } });
      first = Promise.allSettled([services[0].create(f.order.id, f.dto(), f.customer)]);
      await waitingWriters(1);
      const second = services[1].create(f.order.id, f.dto(1), f.customer);
      const outcomes = Promise.allSettled([second]);
      await until(async () => (await counts(f.order.id)).notices === 1);
      expect((await outcomes)[0].status).toBe('fulfilled');
    } finally {
      await blocker.rollbackTransaction();
      await blocker.release();
      if (first) pending = await first;
    }
    expect(pending[0].status).toBe('fulfilled');
    expect(await counts(f.order.id)).toEqual({ claims: 2, notices: 2 });
  }, 15000);

  it.each([WarrantyClaimStatus.RESOLVED, WarrantyClaimStatus.REJECTED])('allows one new claim after terminal %s without changing history', async status => {
    const f = await fixture();
    const previous = await observer.getRepository(WarrantyClaim).save({ serviceOrderId: f.order.id,
      warrantyCoverageId: f.coverages[0].id, customerId: f.customer.id, technicianId: f.technicianId,
      description: 'Historical resolved claim', status });
    oneWinner(await race(f));
    expect(await counts(f.order.id)).toEqual({ claims: 2, notices: 1 });
    expect((await observer.getRepository(WarrantyClaim).findOneByOrFail({ id: previous.id })).status).toBe(status);
  });

  it.each([WarrantyClaimStatus.SUBMITTED, WarrantyClaimStatus.ACCEPTED, WarrantyClaimStatus.INSPECTED,
    WarrantyClaimStatus.IN_PROGRESS, WarrantyClaimStatus.AWAITING_CUSTOMER, WarrantyClaimStatus.DISPUTED])('rejects another claim while %s is active', async status => {
    const f = await fixture();
    await observer.getRepository(WarrantyClaim).save({ serviceOrderId: f.order.id,
      warrantyCoverageId: f.coverages[0].id, customerId: f.customer.id, technicianId: f.technicianId,
      description: 'Existing active claim', status });
    await expect(services[0].create(f.order.id, f.dto(), f.customer)).rejects.toMatchObject({ status: 409 });
    expect(await counts(f.order.id)).toEqual({ claims: 1, notices: 0 });
  });

  it('rolls back a COMMIT failure without notifying and releases the lock for retry', async () => {
    const f = await fixture();
    await expect(services[0].create(f.order.id, { ...f.dto(), description: 'QA reject commit' }, f.customer)).rejects.toThrow('QA commit rejected');
    expect(await counts(f.order.id)).toEqual({ claims: 0, notices: 0 });
    expect(committedBeforeNotice).toEqual([]);
    await services[1].create(f.order.id, f.dto(), f.customer);
    expect(await counts(f.order.id)).toEqual({ claims: 1, notices: 1 });
    expect(committedBeforeNotice).toEqual([1]);
  });

  it('retains a committed claim if notification storage fails; retry cannot save another claim', async () => {
    const f = await fixture();
    vi.mocked(notifications.createNotification).mockRejectedValueOnce(new Error('Synthetic notification failure'));
    await expect(services[0].create(f.order.id, f.dto(), f.customer)).resolves.toMatchObject({ status: WarrantyClaimStatus.SUBMITTED });
    await expect(services[1].create(f.order.id, f.dto(), f.customer)).rejects.toMatchObject({ status: 409 });
    expect(await counts(f.order.id)).toEqual({ claims: 1, notices: 0 });
  });

  it('retains ownership, role, completed-order, coverage ownership, voided and expiry rules', async () => {
    const f = await fixture();
    for (const actor of [{ id: randomUUID(), role: Role.CUSTOMER }, { id: f.customer.id, role: Role.TECHNICIAN }]) {
      await expect(services[0].create(f.order.id, f.dto(), actor)).rejects.toMatchObject({ status: 403 });
    }
    await observer.getRepository(ServiceOrder).update(f.order.id, { status: ServiceOrderStatus.UNDER_REPAIR });
    await expect(services[0].create(f.order.id, f.dto(), f.customer)).rejects.toMatchObject({ status: 409 });
    await observer.getRepository(ServiceOrder).update(f.order.id, { status: ServiceOrderStatus.COMPLETED });
    const other = await fixture();
    await expect(services[0].create(f.order.id, other.dto(), f.customer)).rejects.toMatchObject({ status: 404 });
    await observer.getRepository(WarrantyCoverage).update(f.coverages[0].id, { status: WarrantyStatus.VOIDED });
    await expect(services[0].create(f.order.id, f.dto(), f.customer)).rejects.toMatchObject({ status: 422 });
    expect(await counts(f.order.id)).toEqual({ claims: 0, notices: 0 });
    await observer.getRepository(WarrantyCoverage).update(f.coverages[0].id, {
      status: WarrantyStatus.ACTIVE, expiresAt: new Date(Date.now() - 86400000),
    });
    await expect(services[0].create(f.order.id, f.dto(), f.customer)).resolves.toMatchObject({ submittedAfterExpiry: true });
    expect(await counts(f.order.id)).toEqual({ claims: 1, notices: 1 });
  });
});
