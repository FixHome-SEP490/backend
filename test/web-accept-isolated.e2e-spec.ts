// Runs ONLY against the owner-approved disposable localhost PostgreSQL sandbox.
// Exactly three synthetic actor accounts; no email, SMS, payment, AI, external media or public storage.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { resolve } from 'path';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runtimeRequire = createRequire(resolve('package.json'));
const schema = `web_accept_${randomUUID().replace(/-/g, '')}`;
type Role = 'customer' | 'technician';
type Actor = { id: string; role: Role; token: string };
const unwrap = (body: { data?: unknown }): any => body.data ?? body;

describe('WEB-ACCEPT isolated real HTTP/JWT/PostgreSQL (three synthetic actors)', () => {
  let app: INestApplication | undefined;
  let db: DataSource | undefined;
  let admin: Client | undefined;
  let customer: Actor;
  let techA: Actor;
  let techB: Actor;
  let jwt: JwtService;
  beforeAll(async () => {
    const isExplicitSandbox =
      process.env.DATABASE_PORT === '55490' &&
      process.env.DATABASE_USER === 'fixhome_accept' &&
      process.env.DATABASE_NAME === 'fixhome_accept_sandbox';

    const isDisposableLocalOrCi =
      (process.env.DATABASE_HOST === '127.0.0.1' ||
        process.env.DATABASE_HOST === 'localhost' ||
        !process.env.DATABASE_HOST) &&
      process.env.DATABASE_SSL !== 'true';

    if (!isExplicitSandbox && !isDisposableLocalOrCi) {
      throw Error('Refusing E2E outside disposable localhost FixHome accept database');
    }
    if (['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'MAIL_USERNAME',
      'MAIL_PASSWORD', 'AI_API_KEY', 'STRIPE_SECRET_KEY'].some(key => !!process.env[key])) {
      throw Error('Refusing test process containing external provider configuration');
    }
    Object.assign(process.env, {
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
      JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
      JWT_ACCESS_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d',
      CORS_ORIGIN: 'http://127.0.0.1:5173',
      SUPABASE_KYC_BUCKET: 'kyc-private-test',
    });
    const credentials = isExplicitSandbox
      ? {
          host: '127.0.0.1',
          port: 55490,
          user: 'fixhome_accept',
          database: 'fixhome_accept_sandbox',
          password: process.env.DATABASE_PASSWORD,
        }
      : {
          host: process.env.DATABASE_HOST || '127.0.0.1',
          port: Number(process.env.DATABASE_PORT || 5432),
          user: process.env.DATABASE_USER || 'postgres',
          database: process.env.DATABASE_NAME || 'fixhome',
          password: process.env.DATABASE_PASSWORD || 'postgres',
        };
    admin = new Client(credentials);
    await admin.connect();
    const identity = (await admin.query('select current_database() db, current_user usr')).rows[0];
    if (identity.db !== credentials.database || identity.usr !== credentials.user) throw Error('DB identity mismatch');
    await admin.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: 'postgres',
      host: credentials.host,
      port: credentials.port,
      username: credentials.user,
      password: credentials.password,
      database: credentials.database,
      schema,
      extra: { options: `-c search_path=${schema},public` },
      entities: [resolve('dist/**/*.entity.js')],
      migrations: [resolve('dist/database/migrations/*.js')],
      synchronize: false,
      logging: false,
    });
    await db.initialize();
    await db.runMigrations();
    const { seedRbac } = runtimeRequire('./dist/database/seeds/seed-rbac.js');
    await seedRbac(db);
    const { AppModule } = runtimeRequire('./dist/app.module.js');
    const { configureApplication } = runtimeRequire('./dist/setup-app.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource).useValue(db).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    configureApplication(app);
    await app.init();
    jwt = app.get(JwtService);
    const createActor = async (role: Role): Promise<Actor> => {
      const id = randomUUID();
      await db!.getRepository('User').save({ id, email: `${id}@example.test`,
        fullName: `Synthetic ${role}`, passwordHash: 'synthetic-no-login', role,
        status: 'active', isActive: true, isEmailVerified: true });
      if (role === 'technician') await db!.getRepository('TechnicianProfile').save({ userId: id });
      const token = jwt.sign({ sub: id, role }, { secret: process.env.JWT_ACCESS_SECRET!, algorithm: 'HS256', expiresIn: '15m' });
      return { id, role, token };
    };
    customer = await createActor('customer');
    techA = await createActor('technician');
    techB = await createActor('technician');
    expect(await db.getRepository('User').count()).toBe(3);
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (db?.isInitialized) await db.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  }, 60000);

  it('allows exactly one concurrent Accept and restricts loser and old assignee reads', async () => {
    const database = db!;
    const http = () => request(app!.getHttpServer());
    const post = (path: string, actor: Actor, body: object) => http().post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${actor.token}`).send(body);
    const get = (path: string, actor: Actor) => http().get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${actor.token}`);
    const save = (entity: string, data: object) => database.getRepository(entity).save(data);
    const category = await save('ServiceCategory', { name: 'Synthetic Category', code: randomUUID() });
    const service = await save('Service', { categoryId: category.id, name: 'Synthetic Repair', code: randomUUID(),
      pricingMode: 'fixed_price', fixedPrice: 200000, scopeDescription: 'Synthetic scope', unit: 'job' });
    const address = await save('Address', { userId: customer.id, label: 'Synthetic',
      line1: 'PRIVATE_SYNTHETIC_ADDRESS_123', district: 'D1', province: 'P1', lat: 10.77, lng: 106.69 });
    for (const actor of [techA, techB]) {
      const profile = await database.getRepository('TechnicianProfile').findOneByOrFail({ userId: actor.id });
      await database.getRepository('TechnicianProfile').update(profile.id, { verificationStatus: 'verified', isAvailable: true });
      await save('TechnicianSkill', { technicianId: profile.id, serviceId: service.id,
        listedLaborPrice: 100000, verificationStatus: 'verified' });
      await save('Address', { userId: actor.id, line1: 'Synthetic tech shop',
        district: 'D1', province: 'P1', lat: 10.77, lng: 106.69, isDefault: true });
      for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
        await save('TechnicianSchedule', { technicianId: profile.id, dayOfWeek, startTime: '08:00', endTime: '18:00' });
      }
    }
    const arrival = new Date(); arrival.setUTCDate(arrival.getUTCDate() + 2); arrival.setUTCHours(1, 0, 0, 0);
    const bookingResponse = await post('/bookings', customer, { serviceId: service.id,
      addressId: address.id, description: 'Synthetic repair request', quantity: 1,
      preferredStartAt: arrival.toISOString(), preferredEndAt: new Date(+arrival + 3600000).toISOString() });
    expect(bookingResponse.status).toBe(201);
    const booking = unwrap(bookingResponse.body);
    const shortlist = await post(`/bookings/${booking.id}/shortlist`, customer,
      { technicianIds: [techA.id, techB.id] });
    expect(shortlist.status, 'Synthetic shortlist failure: ' + JSON.stringify({ message: shortlist.body?.error?.message, code: shortlist.body?.error?.code })).toBe(201);
    const invitations = await database.getRepository('BookingInvitation').find({ where: { bookingId: booking.id } });
    expect(invitations).toHaveLength(2);
    const firstInvitation = invitations.find((inv: { technicianId: string }) => inv.technicianId === techA.id);
    const secondInvitation = invitations.find((inv: { technicianId: string }) => inv.technicianId === techB.id);
    expect(firstInvitation).toBeTruthy();
    expect(secondInvitation).toBeTruthy();
    expect(firstInvitation.status).toBe('pending');
    expect(secondInvitation.status).toBe('standby');
    expect(secondInvitation.expiresAt).toBeNull();
    const previewA = await get('/invitations/my', techA);
    const previewB = await get('/invitations/my', techB);
    expect(previewA.status).toBe(200);
    expect(previewB.status).toBe(200);
    expect(JSON.stringify(previewA.body)).toContain(booking.id);
    expect(JSON.stringify(previewB.body)).not.toContain(booking.id);
    expect(JSON.stringify(previewA.body)).not.toContain(customer.id);
    expect(JSON.stringify(previewA.body)).not.toMatch(/PRIVATE_SYNTHETIC_ADDRESS_123|customerPhone|addressTextSnapshot|media|diagnosis/i);
    const prematureB = await post(`/invitations/${secondInvitation.id}/respond`, techB, { action: 'ACCEPT' });
    expect(prematureB.status).toBe(409);
    expect(prematureB.body?.error?.code).toBe('INVITATION_ALREADY_TAKEN');
    expect(JSON.stringify(prematureB.body)).not.toMatch(/PRIVATE_SYNTHETIC_ADDRESS_123|customerPhone|addressTextSnapshot|media|diagnosis/i);
    const firstAccept = await post(`/invitations/${firstInvitation.id}/respond`, techA, { action: 'ACCEPT' });
    expect(firstAccept.status).toBe(200);
    const rejectedAccept = await post(`/invitations/${secondInvitation.id}/respond`, techB, { action: 'ACCEPT' });
    expect(rejectedAccept.status).toBe(409);
    expect(rejectedAccept.body?.error?.code).toBe('INVITATION_ALREADY_TAKEN');
    expect(JSON.stringify(rejectedAccept.body)).not.toMatch(/PRIVATE_SYNTHETIC_ADDRESS_123|customerPhone|addressTextSnapshot|media|diagnosis/i);
    const winner = techA;
    const loser = techB;
    const serviceOrder = unwrap(firstAccept.body).serviceOrder;
    expect(serviceOrder?.id).toBeTruthy();
    const orders = await database.getRepository('ServiceOrder').find({ where: { bookingId: booking.id } });
    const assignments = await database.getRepository('TechnicianAssignment').find({ where: { serviceOrderId: serviceOrder.id } });
    expect(orders).toHaveLength(1);
    expect(assignments.filter((assignment: { isActive: boolean }) => assignment.isActive)).toHaveLength(1);
    expect(assignments[0].technicianId).toBe(winner.id);
    expect((await get(`/bookings/${booking.id}`, customer)).body.data.serviceOrderId).toBe(serviceOrder.id);
    expect((await get(`/service-orders/${serviceOrder.id}`, winner)).status).toBe(200);
    expect((await get(`/service-orders/${serviceOrder.id}`, customer)).status).toBe(200);
    const rejectedOrder = await get(`/service-orders/${serviceOrder.id}`, loser);
    expect(rejectedOrder.status).toBe(403);
    expect(JSON.stringify(rejectedOrder.body)).not.toMatch(/PRIVATE_SYNTHETIC_ADDRESS_123|customerPhone|addressTextSnapshot|media|diagnosis/i);
    const rejectedBooking = await get(`/bookings/${booking.id}`, loser);
    expect(rejectedBooking.status).toBe(404);
    expect(rejectedBooking.body?.error?.code).toBe('OWNERSHIP_DENIED');
    expect(JSON.stringify(rejectedBooking.body)).not.toMatch(/PRIVATE_SYNTHETIC_ADDRESS_123|customerPhone|addressTextSnapshot|media|diagnosis/i);
    await database.getRepository('TechnicianAssignment').update(assignments[0].id, { isActive: false,
      unassignedAt: new Date(), unassignReason: 'Synthetic reassignment/privacy gate' });
    const historical = await get(`/service-orders/${serviceOrder.id}`, winner);
    expect(historical.status).toBe(200);
    expect(historical.body.data).toMatchObject({ id: serviceOrder.id, historical: true, code: serviceOrder.code });
    expect(JSON.stringify(historical.body.data)).not.toMatch(/PRIVATE_SYNTHETIC_ADDRESS_123|customerPhone|addressSummary|destination|bookingId|media|diagnosis/i);
    const list = await get('/service-orders/my', winner);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: serviceOrder.id, historical: true });
    expect(JSON.stringify(list.body.data)).not.toMatch(/PRIVATE_SYNTHETIC_ADDRESS_123|customerPhone|addressSummary|destination|bookingId|media|diagnosis/i);
  }, 60000);

  it('expires and cancels invitations, then rematches after technician withdrawal without leaking private data', async () => {
    const database = db!;
    const http = () => request(app!.getHttpServer());
    const post = (path: string, actor: Actor, body: object) => http().post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${actor.token}`).send(body);
    const get = (path: string, actor: Actor) => http().get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${actor.token}`);
    const save = (entity: string, data: object) => database.getRepository(entity).save(data);
    const category = await save('ServiceCategory', { name: 'Synthetic Expiry Category', code: randomUUID() });
    const service = await save('Service', { categoryId: category.id, name: 'Synthetic Expiry Repair',
      code: randomUUID(), pricingMode: 'fixed_price', fixedPrice: 200000,
      scopeDescription: 'Synthetic scope', unit: 'job' });
    const address = await save('Address', { userId: customer.id, label: 'Synthetic Expiry',
      line1: 'PRIVATE_SYNTHETIC_EXPIRY_456', district: 'D1', province: 'P1', lat: 10.77, lng: 106.69 });
    for (const actor of [techA, techB]) {
      const profile = await database.getRepository('TechnicianProfile').findOneByOrFail({ userId: actor.id });
      await database.getRepository('TechnicianProfile').update(profile.id,
        { verificationStatus: 'verified', isAvailable: true });
      await save('TechnicianSkill', { technicianId: profile.id, serviceId: service.id,
        listedLaborPrice: 100000, verificationStatus: 'verified' });
      if (!await database.getRepository('Address').count({ where: { userId: actor.id, isDefault: true } })) {
        await save('Address', { userId: actor.id, line1: 'Synthetic tech shop',
          district: 'D1', province: 'P1', lat: 10.77, lng: 106.69, isDefault: true });
      }
      if (!await database.getRepository('TechnicianSchedule').count({ where: { technicianId: profile.id } })) {
        for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
          await save('TechnicianSchedule', { technicianId: profile.id,
            dayOfWeek, startTime: '08:00', endTime: '18:00' });
        }
      }
    }
    const arrival = new Date(); arrival.setUTCDate(arrival.getUTCDate() + 4);
    arrival.setUTCHours(1, 0, 0, 0);
    const createBooking = async () => {
      const response = await post('/bookings', customer, { serviceId: service.id,
        addressId: address.id, description: 'Synthetic expiry request', quantity: 1,
        preferredStartAt: arrival.toISOString(),
        preferredEndAt: new Date(+arrival + 3600000).toISOString() });
      expect(response.status).toBe(201);
      return unwrap(response.body);
    };
    const first = await createBooking();
    const shortlist = await post(`/bookings/${first.id}/shortlist`, customer,
      { technicianIds: [techA.id, techB.id] });
    expect(shortlist.status).toBe(201);
    const firstInvitations = await database.getRepository('BookingInvitation').find({
      where: { bookingId: first.id },
    });
    expect(firstInvitations).toHaveLength(2);
    const inviteA = firstInvitations.find((invite: { technicianId: string }) => invite.technicianId === techA.id);
    const inviteB = firstInvitations.find((invite: { technicianId: string }) => invite.technicianId === techB.id);
    expect(inviteA.status).toBe('pending');
    expect(inviteB.status).toBe('standby');
    await database.getRepository('BookingInvitation').update(
      { id: inviteA.id }, { expiresAt: new Date(Date.now() - 60_000) });
    const inbox = await get('/invitations/my', techA);
    expect(inbox.status).toBe(200);
    expect(JSON.stringify(inbox.body)).not.toContain(first.id);
    const firstRoundInboxB = await get('/invitations/my', techB);
    expect(firstRoundInboxB.status).toBe(200);
    expect(JSON.stringify(firstRoundInboxB.body)).toContain(inviteB.id);
    const afterFirstExpired = await database.getRepository('BookingInvitation').find({ where: { bookingId: first.id } });
    expect(afterFirstExpired.find((invite: { id: string }) => invite.id === inviteA.id)?.status).toBe('expired');
    expect(afterFirstExpired.find((invite: { id: string }) => invite.id === inviteB.id)?.status).toBe('pending');
    await database.getRepository('BookingInvitation').update({ id: inviteB.id }, { expiresAt: new Date(Date.now() - 60_000) });
    await get('/invitations/my', techB);
    const expiredInvitations = await database.getRepository('BookingInvitation').find({ where: { bookingId: first.id } });
    expect(expiredInvitations.every((invite: { status: string }) => invite.status === 'expired')).toBe(true);
    const lateAccept = await post(`/invitations/${firstInvitations.find((invite: { technicianId: string }) => invite.technicianId === techA.id)!.id}/respond`, techA,
      { action: 'ACCEPT' });
    expect(lateAccept.status).toBe(409);
    expect(lateAccept.body?.error?.code).toBe('INVITATION_ALREADY_TAKEN');
    expect(JSON.stringify(lateAccept.body)).not.toMatch(/PRIVATE_SYNTHETIC_EXPIRY_456|customerPhone|addressTextSnapshot|media|diagnosis/i);
    expect(await database.getRepository('ServiceOrder').count({ where: { bookingId: first.id } }))
      .toBe(0);

    const second = await createBooking();
    const shortlistSecond = await post(`/bookings/${second.id}/shortlist`, customer,
      { technicianIds: [techA.id, techB.id] });
    expect(shortlistSecond.status).toBe(201);
    const secondInvitations = await database.getRepository('BookingInvitation').find({
      where: { bookingId: second.id },
    });
    const cancelled = await post(`/bookings/${second.id}/cancel`, customer,
      { reason: 'Synthetic cancelled before acceptance' });
    expect(cancelled.status).toBe(200);
    expect(unwrap(cancelled.body).status).toBe('cancelled');
    const cancelledInvitations = await database.getRepository('BookingInvitation').find({
      where: { bookingId: second.id },
    });
    expect(cancelledInvitations).toHaveLength(2);
    expect(cancelledInvitations.every((invite: { status: string }) => invite.status === 'cancelled'))
      .toBe(true);
    const rejected = await post(`/invitations/${secondInvitations.find((invite: { technicianId: string }) => invite.technicianId === techA.id)!.id}/respond`, techA,
      { action: 'ACCEPT' });
    expect(rejected.status).toBe(409);
    expect(rejected.body?.error?.code).toBe('INVITATION_ALREADY_TAKEN');
    expect(JSON.stringify(rejected.body)).not.toMatch(/PRIVATE_SYNTHETIC_EXPIRY_456|customerPhone|addressTextSnapshot|media|diagnosis/i);
    expect(await database.getRepository('ServiceOrder').count({ where: { bookingId: second.id } }))
      .toBe(0);

    const third = await createBooking();
    const shortlistThird = await post(`/bookings/${third.id}/shortlist`, customer,
      { technicianIds: [techA.id, techB.id] });
    expect(shortlistThird.status).toBe(201);
    const thirdInvitations = await database.getRepository('BookingInvitation').find({
      where: { bookingId: third.id },
    });
    const firstInvite = thirdInvitations.find((invite: { technicianId: string }) => invite.technicianId === techA.id);
    expect(firstInvite).toBeTruthy();
    const acceptedA = await post(`/invitations/${firstInvite!.id}/respond`, techA,
      { action: 'ACCEPT' });
    expect(acceptedA.status).toBe(200);
    const thirdOrderId = unwrap(acceptedA.body).serviceOrder?.id;
    expect(thirdOrderId).toBeTruthy();
    const withdrawal = await post(`/service-orders/${thirdOrderId}/cancel`, techA,
      { reason: 'Synthetic withdrawal before arrival' });
    expect(withdrawal.status).toBe(200);
    const afterWithdrawal = await database.getRepository('TechnicianAssignment').find({
      where: { serviceOrderId: thirdOrderId },
    });
    expect(afterWithdrawal.filter((assignment: { isActive: boolean }) => assignment.isActive))
      .toHaveLength(0);
    const inboxB = await get('/invitations/my', techB);
    expect(inboxB.status).toBe(200);
    const replacementInvitations = await database.getRepository('BookingInvitation').find({
      where: { bookingId: third.id, technicianId: techB.id },
      order: { priorityOrder: 'DESC' },
    });
    expect(replacementInvitations[0]?.status).toBe('pending');
    expect(JSON.stringify(inboxB.body)).toContain(replacementInvitations[0].id);
    expect(JSON.stringify(inboxB.body)).not.toMatch(/PRIVATE_SYNTHETIC_EXPIRY_456|customerPhone|addressTextSnapshot|media|diagnosis/i);
    const acceptedB = await post(`/invitations/${replacementInvitations[0].id}/respond`, techB,
      { action: 'ACCEPT' });
    expect(acceptedB.status).toBe(200);
    expect(unwrap(acceptedB.body).serviceOrder?.id).toBe(thirdOrderId);
    const assignedB = await database.getRepository('TechnicianAssignment').find({
      where: { serviceOrderId: thirdOrderId },
    });
    expect(assignedB.filter((assignment: { isActive: boolean }) => assignment.isActive))
      .toHaveLength(1);
    expect(assignedB.find((assignment: { isActive: boolean }) => assignment.isActive)?.technicianId)
      .toBe(techB.id);
    const oldReplay = await post(`/invitations/${firstInvite!.id}/respond`, techA,
      { action: 'ACCEPT' });
    expect(oldReplay.status).toBe(409);
    expect(oldReplay.body?.error?.code).toBe('INVITATION_ALREADY_TAKEN');
    expect(JSON.stringify(oldReplay.body)).not.toMatch(/PRIVATE_SYNTHETIC_EXPIRY_456|customerPhone|addressTextSnapshot|media|diagnosis/i);
    const oldBooking = await get(`/bookings/${third.id}`, techA);
    expect(oldBooking.status).toBe(404);
    const oldOrder = await get(`/service-orders/${thirdOrderId}`, techA);
    expect(oldOrder.status).toBe(200);
    expect(oldOrder.body.data).toMatchObject({ id: thirdOrderId, historical: true });
    expect(JSON.stringify(oldOrder.body.data)).not.toMatch(/PRIVATE_SYNTHETIC_EXPIRY_456|customerPhone|addressTextSnapshot|destination|bookingId|media|diagnosis/i);
    expect((await get(`/service-orders/${thirdOrderId}`, techB)).status).toBe(200);
    expect((await get(`/bookings/${third.id}`, customer)).body.data.serviceOrderId).toBe(thirdOrderId);
  }, 60000);});
