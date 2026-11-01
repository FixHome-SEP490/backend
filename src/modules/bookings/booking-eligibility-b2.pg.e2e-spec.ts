import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { Booking } from './entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { Service } from '../services/entities/service.entity';
import { ServiceCategory } from '../categories/entities/category.entity';
import { Address } from '../users/entities/address.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianSchedule } from '../technicians/entities/technician-schedule.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { BookingMedia } from './entities/booking-media.entity';
import { InvitationsService } from './invitations.service';
import { BookingsService } from './bookings.service';
import { VisitGroupsService } from '../visit-groups/visit-groups.service';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { technicianEligibility, loadEligibilityBulk } from './technician-eligibility';
import { AccountStatus, BookingStatus, Role, ServicePricingMode, VerificationStatus } from '../../shared/enums';

// Opt-in only; this harness creates its own disposable database and never reads .env.
// @ts-ignore Vitest transforms eager globs; production TypeScript uses CommonJS.
const entities = import.meta.glob('../../**/*.entity.ts', { eager: true });
// @ts-ignore Vitest transforms eager globs; production TypeScript uses CommonJS.
const migrations = import.meta.glob(['../../database/migrations/*.ts', '!../../database/migrations/*.spec.ts'], { eager: true });
const classes = (modules: Record<string, unknown>) => Object.values(modules)
  .flatMap(module => Object.values(module as Record<string, unknown>)).filter((v): v is new () => any => typeof v === 'function');
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(process.env.B2_ISOLATED_PG !== '1')('B2 disposable PostgreSQL booking authority', () => {
  let db: DataSource;
  let container: string;
  let invitations: InvitationsService;
  let bookings: BookingsService;
  beforeAll(async () => {
    const password = randomUUID();
    container = docker('run', '-d', '--rm', '--label', 'fixhome.qa=b2-booking', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=b2_booking', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=b2_disposable', 'postgres:16-alpine');
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Unexpected isolated container ID');
    const identity = JSON.parse(docker('inspect', container))[0];
    const [binding] = identity.NetworkSettings.Ports['5432/tcp'];
    if (identity.Config.Labels['fixhome.qa'] !== 'b2-booking' || binding.HostIp !== '127.0.0.1') throw new Error('Unsafe PostgreSQL target');
    let ready = false;
    for (let n = 0; n < 60; n++) {
      try { docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'b2_booking'); ready = true; break; }
      catch { await pause(250); }
    }
    if (!ready) throw new Error('Isolated PostgreSQL did not become ready');
    db = new DataSource({ type: 'postgres', host: '127.0.0.1', port: Number(binding.HostPort),
      username: 'b2_booking', password, database: 'b2_disposable', ssl: false, synchronize: false,
      entities: classes(entities), migrations: classes(migrations) });
    await db.initialize();
    expect(await db.query('SELECT current_database() AS db, current_user AS usr')).toEqual([{ db: 'b2_disposable', usr: 'b2_booking' }]);
    await db.runMigrations();
    invitations = new InvitationsService(db.getRepository(BookingInvitation), db.getRepository(Booking), db,
      { getInt: async (_key: string, fallback: number) => fallback } as never,
      { logWithManager: async () => {} } as never,
      { ensureConversation: async () => {}, attachToServiceOrder: async () => {} } as never);
    bookings = new BookingsService(db.getRepository(Booking), db.getRepository(BookingMedia), db.getRepository(User),
      db.getRepository(Service), db.getRepository(Address), db.getRepository(TechnicianProfile), db.getRepository(TechnicianSkill),
      { log: async () => {}, logWithManager: async () => {} } as never, db, {} as never,
      { getInt: async (_key: string, fallback: number) => fallback } as never);
  }, 120000);
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (container && /^[a-f0-9]{64}$/.test(container)) {
      const identity = JSON.parse(docker('inspect', container))[0];
      if (identity.Config.Labels['fixhome.qa'] === 'b2-booking') docker('stop', container);
    }
  }, 60000);

  async function fixture(balance: number | null = 200000) {
    const userRepo = db.getRepository(User);
    const customer = await userRepo.save(userRepo.create({ email: `${randomUUID()}@qa.invalid`, passwordHash: 'synthetic',
      fullName: 'Synthetic customer', role: Role.CUSTOMER, status: AccountStatus.ACTIVE }));
    const technician = await userRepo.save(userRepo.create({ email: `${randomUUID()}@qa.invalid`, passwordHash: 'synthetic',
      fullName: 'Synthetic technician', role: Role.TECHNICIAN, status: AccountStatus.ACTIVE }));
    const category = await db.getRepository(ServiceCategory).save({ name: 'Synthetic category', code: randomUUID(), isActive: true });
    const service = await db.getRepository(Service).save({ name: 'Synthetic service', code: `QA-${randomUUID()}`,
      categoryId: category.id, isActive: true, pricingMode: ServicePricingMode.FIXED_PRICE, fixedPrice: 199000 });
    const address = await db.getRepository(Address).save({ userId: customer.id, line1: 'Synthetic address', province: 'Synthetic', district: 'Synthetic', lat: 10.77, lng: 106.7 });
    await db.getRepository(Address).save({ userId: technician.id, line1: 'Synthetic work address', province: 'Synthetic', district: 'Synthetic', isDefault: true, lat: 10.77, lng: 106.7 });
    const profile = await db.getRepository(TechnicianProfile).save({ userId: technician.id,
      verificationStatus: VerificationStatus.VERIFIED, isAvailable: true, serviceRadiusKm: 10 });
    await db.getRepository(TechnicianSkill).save({ technicianId: profile.id, serviceId: service.id,
      isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    await db.getRepository(TechnicianSchedule).save({ technicianId: profile.id, dayOfWeek: 2, startTime: '08:00', endTime: '18:00' });
    if (balance !== null) await db.getRepository(Wallet).save({ technicianId: technician.id, balance });
    const booking = await db.getRepository(Booking).save({ customerId: customer.id, serviceId: service.id, addressId: address.id,
      description: 'Synthetic repair', status: BookingStatus.SUBMITTED, bookingMode: 'scheduled', slot: 'morning',
      latitudeSnapshot: 10.77, longitudeSnapshot: 106.7,
      preferredStartAt: new Date('2030-10-15T01:00:00Z'), preferredEndAt: new Date('2030-10-15T05:00:00Z') });
    return { customer, technician, profile, booking, category, service, address };
  }

  it.each([[null, false], [0, false], [199999, false], [200000, true]] as const)(
    '#42 balance %s is %s in single and actual bulk loading with distinct User/Profile IDs', async (balance, eligible) => {
      const f = await fixture(balance);
      const profile = await db.getRepository(TechnicianProfile).findOneOrFail({ where: { id: f.profile.id }, relations: ['user'] });
      const bulk = await loadEligibilityBulk(db.manager, f.booking, [profile]);
      expect(f.technician.id).not.toBe(f.profile.id);
      expect(bulk.wallets.has(f.profile.id)).toBe(false);
      const single = await technicianEligibility(db.manager, f.technician.id, f.booking);
      expect(single.eligible).toBe(eligible);
      expect(await technicianEligibility(db.manager, f.technician.id, f.booking, undefined, { bulk })).toEqual(single);
    });

  it.each([null, 0, 199999])('#42 real Accept rejects drained/deleted wallet %s after shortlist without an order', async balance => {
    const f = await fixture();
    const [invitation] = await invitations.createShortlist(f.booking.id, [f.technician.id], { id: f.customer.id, role: Role.CUSTOMER });
    if (balance === null) await db.getRepository(Wallet).delete({ technicianId: f.technician.id });
    else await db.getRepository(Wallet).update({ technicianId: f.technician.id }, { balance });
    await expect(invitations.respond(invitation.id, 'ACCEPT', { id: f.technician.id, role: Role.TECHNICIAN }))
      .rejects.toMatchObject({ status: 409 });
    expect(await db.getRepository(ServiceOrder).countBy({ bookingId: f.booking.id })).toBe(0);
    expect((await db.getRepository(BookingInvitation).findOneByOrFail({ id: invitation.id })).status).toBe('pending');
  });

  it('#42 accepts 200000 and preserves the active order and replay after a later drain', async () => {
    const f = await fixture();
    const [invitation] = await invitations.createShortlist(f.booking.id, [f.technician.id], { id: f.customer.id, role: Role.CUSTOMER });
    const actor = { id: f.technician.id, role: Role.TECHNICIAN };
    const accepted = await invitations.respond(invitation.id, 'ACCEPT', actor);
    expect(accepted.serviceOrder?.status).toBe('accepted');
    await db.getRepository(Wallet).update({ technicianId: f.technician.id }, { balance: 0 });
    const replay = await invitations.respond(invitation.id, 'ACCEPT', actor);
    expect(replay.serviceOrder?.id).toBe(accepted.serviceOrder?.id);
    expect(await db.getRepository(ServiceOrder).countBy({ bookingId: f.booking.id })).toBe(1);
    expect(await technicianEligibility(db.manager, f.technician.id, f.booking, accepted.serviceOrder!.id,
      { keepingExistingOrder: true })).toEqual({ eligible: true });
  });

  it('#42 holds the wallet against a concurrent drain until the eligibility transaction ends', async () => {
    const f = await fixture();
    const accept = db.createQueryRunner(); const drain = db.createQueryRunner();
    await accept.connect(); await drain.connect();
    await accept.startTransaction(); await drain.startTransaction();
    try {
      expect(await technicianEligibility(accept.manager, f.technician.id, f.booking)).toEqual({ eligible: true });
      await drain.query("SET LOCAL lock_timeout = '300ms'");
      await expect(drain.manager.update(Wallet, { technicianId: f.technician.id }, { balance: 0 }))
        .rejects.toMatchObject({ code: '55P03' });
    } finally {
      await drain.rollbackTransaction(); await accept.rollbackTransaction();
      await drain.release(); await accept.release();
    }
    expect((await db.getRepository(Wallet).findOneByOrFail({ technicianId: f.technician.id })).balance).toBe(200000);
  });

  const createDto = (f: Awaited<ReturnType<typeof fixture>>) => ({ serviceId: f.service.id, addressId: f.address.id,
    description: 'Synthetic repair', mode: 'scheduled' as const, date: '2030-10-15', slot: 'morning' as const });

  it.each([true, false])('#32 category active=%s controls new bookings after selection', async active => {
    const f = await fixture();
    const dto = createDto(f); // Web already selected an active service/category.
    await db.getRepository(ServiceCategory).update(f.category.id, { isActive: active });
    const before = await db.getRepository(Booking).countBy({ customerId: f.customer.id });
    const pending = bookings.create(dto, { id: f.customer.id, role: Role.CUSTOMER });
    if (active) {
      const created = await pending;
      expect(created.serviceId).toBe(f.service.id);
      expect(Number(created.fixedUnitPriceSnapshot)).toBe(199000);
    } else await expect(pending).rejects.toMatchObject({ status: 404 });
    expect(await db.getRepository(Booking).countBy({ customerId: f.customer.id })).toBe(before + (active ? 1 : 0));
    expect(await db.getRepository(BookingInvitation).countBy({ bookingId: f.booking.id })).toBe(0);
  });

  it('#32 rebook rejects a paused category while historical booking detail remains readable', async () => {
    const f = await fixture();
    await db.getRepository(Booking).update(f.booking.id, { status: BookingStatus.CANCELLED });
    await db.getRepository(ServiceCategory).update(f.category.id, { isActive: false });
    const customer = { id: f.customer.id, role: Role.CUSTOMER };
    await expect(bookings.rebook(f.booking.id, customer, createDto(f))).rejects.toMatchObject({ status: 404 });
    expect(await db.getRepository(Booking).countBy({ customerId: f.customer.id })).toBe(1);
    expect(await bookings.findById(f.booking.id, customer)).toMatchObject({ id: f.booking.id, status: BookingStatus.CANCELLED });
  });

  it('#32 VisitGroup rolls back the active first child when a later category is paused', async () => {
    const f = await fixture(); const disabled = await fixture();
    await db.getRepository(ServiceCategory).update(disabled.category.id, { isActive: false });
    const groups = Object.assign(Object.create(VisitGroupsService.prototype), {
      dataSource: db, groupRepo: db.getRepository(VisitGroup), itemRepo: db.getRepository(VisitGroupItem), bookingsService: bookings,
      config: { getString: async () => 'true' }, auditLogService: { logWithManager: async () => {} },
    }) as VisitGroupsService;
    const dto = { ...createDto(f), items: [{ serviceId: f.service.id, description: 'Synthetic first' },
      { serviceId: disabled.service.id, description: 'Synthetic disabled second' }] };
    await expect(groups.create(dto, { id: f.customer.id, role: Role.CUSTOMER })).rejects.toMatchObject({ status: 404 });
    expect(await db.getRepository(Booking).countBy({ customerId: f.customer.id })).toBe(1);
    expect(await db.getRepository(VisitGroup).countBy({ customerId: f.customer.id })).toBe(0);
    expect(await db.getRepository(VisitGroupItem).count()).toBe(0);
  });

  it('#32 serializes category pause behind the booking transaction until its snapshot commits', async () => {
    const f = await fixture();
    const create = db.createQueryRunner(); const admin = db.createQueryRunner();
    await create.connect(); await admin.connect(); await create.startTransaction(); await admin.startTransaction();
    try {
      const booking = await bookings.create(createDto(f), { id: f.customer.id, role: Role.CUSTOMER },
        { manager: create.manager, visitGroupId: null });
      expect(Number(booking.fixedUnitPriceSnapshot)).toBe(199000);
      await admin.query("SET LOCAL lock_timeout = '300ms'");
      await expect(admin.manager.update(ServiceCategory, f.category.id, { isActive: false })).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await admin.rollbackTransaction(); await create.rollbackTransaction(); await admin.release(); await create.release();
    }
  });

  it('#32 waits for an in-flight category pause and rejects after that pause commits', async () => {
    const f = await fixture(); const admin = db.createQueryRunner();
    await admin.connect(); await admin.startTransaction();
    const [{ pid }] = await admin.query('SELECT pg_backend_pid() AS pid');
    let pending: Promise<{ value?: Booking; error?: unknown }> | undefined;
    try {
      await admin.manager.update(ServiceCategory, f.category.id, { isActive: false });
      pending = bookings.create(createDto(f), { id: f.customer.id, role: Role.CUSTOMER })
        .then(value => ({ value }), error => ({ error }));
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        const [row] = await db.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked`, [pid]);
        if (row.blocked) { blocked = true; break; }
        await pause(20);
      }
      expect(blocked).toBe(true);
      await admin.commitTransaction();
      expect(await pending).toMatchObject({ error: { status: 404 } });
      expect(await db.getRepository(Booking).countBy({ customerId: f.customer.id })).toBe(1);
    } finally {
      if (admin.isTransactionActive) await admin.rollbackTransaction();
      await admin.release();
      if (pending) await pending;
    }
  });
});
