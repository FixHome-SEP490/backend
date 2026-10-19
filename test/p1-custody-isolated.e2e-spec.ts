// NEVER imports AppModule, dotenv, a data-source file or external adapters.
// Explicit opt-in to a disposable localhost DB with a fixed synthetic identity only.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const runtime = createRequire(resolve('package.json'));
const port = Number(process.env.P1_DISPOSABLE_POSTGRES_PORT);
const secret = 'p1-disposable-test-only-jwt-secret-at-least-32-characters';
const load = (path: string, symbol: string) => runtime(`./dist/${path}.js`)[symbol];
const repo = (db: DataSource, name: string) => db.getRepository(name);

describe.skipIf(!port)('P1 isolated PostgreSQL / real JWT / transaction entrypoints', () => {
  let db: DataSource;
  let app: INestApplication;
  let custody: any;
  let parts: any;
  let wallet: any;
  let settlement: any;
  let invitations: any;
  let assignments: any;
  let withdrawal: any;
  let finance: any;
  let sweeper: any;
  let jwt: JwtService;
  const audit = { logWithManager: vi.fn().mockResolvedValue(undefined) };
  const notices = { createNotification: vi.fn().mockResolvedValue(undefined) };
  const businessConfig = { getBigInt: async () => 0n, getInt: async (_key: string, fallback: number) => fallback };
  const payout = { name: 'payos', estimateCredit: vi.fn(async () => 1), getSourceBalance: vi.fn(async () => 10000000),
    createPayout: vi.fn(async () => ({ outcome: 'SUCCEEDED', payoutId: 'synthetic', providerState: 'SUCCESS' })) };

  beforeAll(async () => {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid disposable PostgreSQL port');
    vi.stubEnv('P1_CUSTODY_ENABLED', 'true');
    db = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'fixhome_p1_test',
      password: 'disposable_p1_only', database: 'fixhome_p1_disposable',
      entities: [resolve('dist/**/*.entity.js')], migrations: [resolve('dist/database/migrations/*.js')],
      synchronize: false, logging: false, extra: { max: 12, options: '-c lock_timeout=5000 -c statement_timeout=10000' } });
    await db.initialize();
    const [identity] = await db.query('SELECT current_database() AS db, current_user AS usr');
    expect(identity).toEqual({ db: 'fixhome_p1_disposable', usr: 'fixhome_p1_test' });
    await db.runMigrations(); // Only this disposable database; never the project data-source.
    expect((await db.query('SELECT enabled, activated_at FROM part_custody_activation'))[0]).toEqual({ enabled: false, activated_at: null });

    const Custody = load('modules/part-requests/part-custody.service', 'PartCustodyService');
    const Parts = load('modules/part-requests/part-requests.service', 'PartRequestsService');
    const Wallet = load('modules/wallet/wallet.service', 'WalletService');
    const Settlement = load('modules/wallet/settlement.service', 'SettlementService');
    custody = new Custody(db);
    parts = new Parts(db, repo(db, 'PartRequest'), repo(db, 'PartRequestItem'), repo(db, 'FixHomePart'), audit, notices, custody);
    wallet = new Wallet(repo(db, 'Wallet'), repo(db, 'WalletTransaction'), repo(db, 'WithdrawalRequest'), repo(db, 'User'), db, businessConfig, audit);
    settlement = new Settlement(wallet, db);
    const Invitations = load('modules/bookings/invitations.service', 'InvitationsService');
    invitations = new Invitations(repo(db, 'BookingInvitation'), repo(db, 'Booking'), db, businessConfig, audit,
      { ensureConversation: async () => undefined, attachToServiceOrder: async () => undefined });
    const Assignments = load('modules/technician-assignment/technician-assignment.service', 'TechnicianAssignmentService');
    assignments = new Assignments(repo(db, 'TechnicianAssignment'), repo(db, 'ServiceOrder'), repo(db, 'User'), repo(db, 'TechnicianProfile'), db, audit, {});
    const Withdrawal = load('modules/wallet/withdrawal-payout.service', 'WithdrawalPayoutService');
    withdrawal = new Withdrawal(repo(db, 'WithdrawalRequest'), repo(db, 'TechnicianBankAccount'), db, wallet, audit, new ConfigService({ NODE_ENV: 'test' }), payout);
    const Finance = load('modules/finance/finance.service', 'FinanceService');
    finance = Object.assign(Object.create(Finance.prototype), { dataSource: db, auditLogService: audit, configService: businessConfig, settlementService: settlement });
    const Orders = load('modules/service-orders/service-orders.service', 'ServiceOrdersService');
    sweeper = Object.assign(Object.create(Orders.prototype), { dataSource: db, settlementService: settlement, paidSweepRetryAt: new Map(), logger: new Logger('P1TestSweep') });

    const ReturnsController = load('modules/part-requests/part-returns.controller', 'PartReturnsController');
    const PartsController = load('modules/part-requests/part-requests.controller', 'PartRequestsController');
    const JwtStrategy = load('modules/auth/strategies/jwt.strategy', 'JwtStrategy');
    const User = load('modules/users/entities/user.entity', 'User');
    const RolesGuard = load('common/guards/roles.guard', 'RolesGuard');
    const module = await Test.createTestingModule({ imports: [PassportModule, JwtModule.register({ secret })],
      controllers: [ReturnsController, PartsController], providers: [RolesGuard, JwtStrategy,
        { provide: getRepositoryToken(User), useValue: repo(db, 'User') },
        { provide: ConfigService, useValue: new ConfigService({ JWT_ACCESS_SECRET: secret }) },
        { provide: Custody, useValue: custody }, { provide: Parts, useValue: parts }] }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    jwt = module.get(JwtService);
    await db.query('UPDATE part_custody_activation SET enabled = true WHERE id = 1');
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    if (db?.isInitialized) await db.destroy();
    vi.unstubAllEnvs();
  });

  async function fixture() {
    const save = (name: string, fields: object) => repo(db, name).save(fields);
    const actor = async (role: string) => {
      const user = await save('User', { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic-no-login', fullName: 'Synthetic actor', role, status: 'active', isActive: true });
      return { id: user.id, role, token: jwt.sign({ sub: user.id, role }) };
    };
    const tech = await actor('technician'), other = await actor('technician'), manager = await actor('service_manager'), customer = await actor('customer');
    const category = await save('ServiceCategory', { code: randomUUID(), name: 'Synthetic category' });
    const service = await save('Service', { categoryId: category.id, code: randomUUID(), name: 'Synthetic repair', pricingMode: 'fixed_price', fixedPrice: 100000 });
    const profile = await save('TechnicianProfile', { userId: tech.id, verificationStatus: 'verified', isAvailable: true, serviceRadiusKm: 40 });
    await save('TechnicianSkill', { technicianId: profile.id, serviceId: service.id, verificationStatus: 'verified', listedLaborPrice: 100000 });
    await save('Address', { userId: tech.id, line1: 'Synthetic location', province: 'P1', district: 'D1', lat: 10.77, lng: 106.69, isDefault: true });
    await save('TechnicianServiceArea', { technicianId: profile.id, provinceCode: 'P1', districtCode: 'D1' });
    for (let day = 0; day < 7; day++) await save('TechnicianSchedule', { technicianId: profile.id, dayOfWeek: day, startTime: '08:00', endTime: '18:00' });
    const booking = async (days = 2) => {
      const start = new Date(); start.setUTCDate(start.getUTCDate() + days); start.setUTCHours(1, 0, 0, 0);
      return save('Booking', { customerId: customer.id, serviceId: service.id, description: 'Synthetic request', status: 'matching',
        bookingMode: 'scheduled', slot: 'morning', preferredStartAt: start, preferredEndAt: new Date(+start + 14400000),
        latitudeSnapshot: 10.77, longitudeSnapshot: 106.69, provinceSnapshot: 'P1', districtSnapshot: 'D1' });
    };
    const booked = await booking();
    const order = await save('ServiceOrder', { bookingId: booked.id, code: `P1-${randomUUID()}`, status: 'under_repair' });
    await save('TechnicianAssignment', { serviceOrderId: order.id, technicianId: tech.id, isActive: true });
    const part = await save('FixHomePart', { sku: randomUUID(), name: 'Synthetic part', sellingPrice: 100000 });
    const req = await save('PartRequest', { serviceOrderId: order.id, technicianId: tech.id, requestType: 'pre_repair', fulfillmentMethod: 'pickup', status: 'ready', qrToken: `synthetic-${randomUUID()}`, qrGeneratedAt: new Date() });
    const item = await save('PartRequestItem', { partRequestId: req.id, partCatalogId: part.id, partSource: 'fixhome', partNameSnapshot: part.name, quantity: 3, unitPriceSnapshot: 100000 });
    await save('Wallet', { technicianId: tech.id, balance: 1000000 });
    await save('TechnicianBankAccount', { technicianId: tech.id, bankBin: '970000', bankCode: 'TEST', bankName: 'Synthetic bank', accountNumber: '0000000000', accountName: 'SYNTHETIC ACTOR' });
    const post = (path: string, who: typeof tech, body: object) => request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${who.token}`).send(body);
    const get = (path: string, who: typeof tech) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${who.token}`);
    const returns = `/part-requests/${req.id}/items/${item.id}`;
    const receive = () => post(`/part-requests/${req.id}/receive`, tech, { qrToken: req.qrToken });
    const usage = (usedQty = 2) => request(app.getHttpServer()).patch(`${returns}/usage`).set('Authorization', `Bearer ${tech.token}`)
      .send({ usageStatus: usedQty ? 'used' : 'returned', usedQty, expectedVersion: 0, idempotencyKey: `usage-${item.id}` });
    const invoice = (paid = false) => save('Invoice', { serviceOrderId: order.id, laborTotal: 100000, commissionAmount: 10000,
      fixHomePartsTotal: 200000, partsTotal: 250000, technicianPartsTotal: 50000, shippingFee: 0, grandTotal: 350000,
      paymentStatus: paid ? 'paid' : 'unpaid' });
    return { tech, other, manager, customer, order, req, item, save, booking, post, get, returns, receive, usage, invoice };
  }

  it('uses real JWT/roles/ownership, rejects extraneous fields, preserves quantity, replays a concurrent declaration once and records a signed receipt', async () => {
    const f = await fixture();
    expect((await f.receive()).status).toBe(200);
    expect((await f.usage()).status).toBe(200);
    expect((await f.get(`/service-orders/${f.order.id}/part-returns`, f.tech)).body.data[0]).toMatchObject({ issuedQty: 3, usedQty: 2, outstandingQty: 1, version: 1 });
    expect((await f.get(`/service-orders/${f.order.id}/part-returns`, f.other)).status).toBe(403);
    expect((await f.get(`/service-orders/${f.order.id}/part-returns`, f.customer)).status).toBe(403);
    const forged = { ...f.customer, token: jwt.sign({ sub: f.customer.id, role: 'service_manager' }) };
    expect((await f.post(`${f.returns}/accept-return`, forged, { quantity: 1, expectedVersion: 1, idempotencyKey: 'forged-role' })).status).toBe(403);
    const body = { quantity: 1, expectedVersion: 1, idempotencyKey: 'declare-concurrent' };
    expect((await f.post(`${f.returns}/declare-return`, f.other, body)).status).toBe(403);
    expect((await f.post(`${f.returns}/declare-return`, f.tech, { ...body, managerConfirmed: true })).status).toBe(400);
    const responses = await Promise.all([f.post(`${f.returns}/declare-return`, f.tech, body), f.post(`${f.returns}/declare-return`, f.tech, body)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect((await f.post(`${f.returns}/declare-return`, f.tech, { ...body, quantity: 2 })).status).toBe(409);
    expect((await f.post(`${f.returns}/accept-return`, f.customer, { quantity: 1, expectedVersion: 2, idempotencyKey: 'accept-test' })).status).toBe(403);
    const receipts = await Promise.all(['accept-a', 'accept-b'].map(idempotencyKey => f.post(`${f.returns}/accept-return`, f.manager, { quantity: 1, expectedVersion: 2, idempotencyKey })));
    expect(receipts.map(r => r.status).sort()).toEqual([200, 409]);
    const accepted = await repo(db, 'PartCustodyEntry').findOneByOrFail({ kind: 'accept_return', custodyId: responses[0].body.data.id });
    expect(accepted).toMatchObject({ actorUserId: f.manager.id, actorRole: 'service_manager', quantity: 1 });
    expect(accepted.occurredAt).toBeInstanceOf(Date);
    expect((await repo(db, 'PartRequestItem').findOneByOrFail({ id: f.item.id })).quantity).toBe(3);
    await expect(db.query('UPDATE part_custody_entries SET quantity = 2 WHERE id = $1', [accepted.id])).rejects.toThrow('append-only');
    const assertRuntime = load('modules/part-requests/part-custody.policy', 'assertCustodyRuntimeConfiguration');
    vi.stubEnv('P1_CUSTODY_ENABLED', 'false');
    try { await expect(assertRuntime(db.manager)).rejects.toThrow('cannot be disabled'); }
    finally { vi.stubEnv('P1_CUSTODY_ENABLED', 'true'); }
  });

  it('blocks actual Accept, auto-Accept, assignment and wallet withdrawal after cash self-declaration without customer confirmation; manager receipt releases the lock', async () => {
    const f = await fixture(); await f.receive(); await f.usage();
    const invoice = await f.invoice();
    const newBooking = await f.booking(3);
    const invite = await f.save('BookingInvitation', { bookingId: newBooking.id, technicianId: f.tech.id, status: 'pending', priorityOrder: 1, expiresAt: new Date(Date.now() + 3600000) });
    await finance.declareCashSettlement(f.order.id, { declaredAmount: Number(invoice.grandTotal) }, f.tech);
    expect((await repo(db, 'CashSettlement').findOneByOrFail({ serviceOrderId: f.order.id })).status).toBe('pending_confirmation');
    await expect(invitations.respond(invite.id, 'ACCEPT', f.tech)).rejects.toThrow('linh kiện');
    await expect(invitations.respond(invite.id, 'ACCEPT', f.tech, { auto: true })).rejects.toThrow('linh kiện');
    await expect(assignments.assignToBooking(newBooking.id, f.tech.id, f.manager, 'Synthetic assignment')).rejects.toThrow('linh kiện');
    const beforePayout = payout.createPayout.mock.calls.length;
    await expect(withdrawal.withdraw(f.tech.id, 100000)).rejects.toThrow('linh kiện');
    expect(payout.createPayout.mock.calls.length).toBe(beforePayout);
    expect(await repo(db, 'ServiceOrder').countBy({ bookingId: newBooking.id })).toBe(0);
    expect(await repo(db, 'WithdrawalRequest').countBy({ technicianId: f.tech.id })).toBe(0);
    expect((await repo(db, 'ServiceOrder').findOneByOrFail({ id: f.order.id })).status).toBe('under_repair');
    await f.post(`${f.returns}/declare-return`, f.tech, { quantity: 1, expectedVersion: 1, idempotencyKey: 'declare-cash' }).expect(200);
    await f.post(`${f.returns}/accept-return`, f.manager, { quantity: 1, expectedVersion: 2, idempotencyKey: 'accept-cash' }).expect(200);
    expect((await withdrawal.withdraw(f.tech.id, 100000)).status).toBe('SUCCESS');
    expect((await invitations.respond(invite.id, 'ACCEPT', f.tech)).serviceOrder).toBeDefined();
  });

  it('serializes a cash declaration racing both withdrawal and a stale invitation at the real technician lock', async () => {
    const f = await fixture(); await f.receive(); await f.usage(); const invoice = await f.invoice();
    const b = await f.booking(3);
    const invite = await f.save('BookingInvitation', { bookingId: b.id, technicianId: f.tech.id, status: 'pending', priorityOrder: 1, expiresAt: new Date(Date.now() + 3600000) });
    const held = db.createQueryRunner(); await held.connect(); await held.startTransaction();
    try {
      await held.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [f.tech.id]);
      const accepting = invitations.respond(invite.id, 'ACCEPT', f.tech).then(() => 'UNEXPECTED_ACCEPT', e => e.message);
      const withdrawing = withdrawal.withdraw(f.tech.id, 100000).then(() => 'UNEXPECTED_WITHDRAWAL', e => e.message);
      // The real declaration service joins this transaction and holds the same User lock through commit.
      const transactionalFinance = Object.assign(Object.create(Object.getPrototypeOf(finance)), finance,
        { dataSource: { transaction: (cb: any) => cb(held.manager) } });
      await transactionalFinance.declareCashSettlement(f.order.id, { declaredAmount: Number(invoice.grandTotal) }, f.tech);
      await held.commitTransaction();
      expect(await accepting).toContain('linh kiện'); expect(await withdrawing).toContain('linh kiện');
    } finally {
      if (held.isTransactionActive) await held.rollbackTransaction();
      await held.release();
    }
  });

  it('holds all NET_LABOR at finance callback and sweep boundaries, credits nonlabor immediately and releases once under concurrent retries', async () => {
    const f = await fixture(); await f.receive(); await f.usage(); const invoice = await f.invoice();
    await repo(db, 'ServiceOrder').update(f.order.id, { status: 'completed', completedAt: new Date() });
    const callback = () => db.transaction(m => finance.markInvoicePaidOnline(m, invoice, f.customer.id, new Date()));
    await callback();
    expect((await repo(db, 'ServiceOrder').findOneByOrFail({ id: f.order.id })).paymentStatus).toBe('paid');
    expect((await repo(db, 'Invoice').findOneByOrFail({ id: invoice.id })).paymentStatus).toBe('paid');
    const credit = () => db.query("SELECT amount FROM wallet_transactions WHERE reference_id = $1 AND type::text = 'ONLINE_EARNING' ORDER BY created_at", [f.order.id]);
    expect((await credit()).map(r => Number(r.amount))).toEqual([50000]);
    await Promise.all([callback(), sweeper.sweepPaidOrders(), settlement.trySettleOrder(f.order.id)]);
    expect((await credit()).map(r => Number(r.amount))).toEqual([50000]);
    await f.post(`${f.returns}/declare-return`, f.tech, { quantity: 1, expectedVersion: 1, idempotencyKey: 'declare-online' }).expect(200);
    await f.post(`${f.returns}/accept-return`, f.manager, { quantity: 1, expectedVersion: 2, idempotencyKey: 'accept-online' }).expect(200);
    // New sweep instance models a later scheduled retry; the original instance backs held orders off 15 minutes.
    sweeper.paidSweepRetryAt.clear();
    await Promise.all([callback(), sweeper.sweepPaidOrders(), settlement.trySettleOrder(f.order.id)]);
    await callback(); await sweeper.sweepPaidOrders();
    expect((await credit()).map(r => Number(r.amount))).toEqual([50000, 90000]);
    expect(await repo(db, 'CustodyPayout').countBy({ invoiceId: invoice.id })).toBe(2);
    expect((await repo(db, 'Invoice').findOneByOrFail({ id: invoice.id })).grandTotal).toBe('350000');
  });

  it('does not enroll old handovers or touch old paid invoices when the flag is later enabled', async () => {
    const f = await fixture();
    vi.stubEnv('P1_CUSTODY_ENABLED', 'false');
    try { await f.receive().expect(200); }
    finally { vi.stubEnv('P1_CUSTODY_ENABLED', 'true'); }
    expect(await repo(db, 'PartCustody').countBy({ partRequestItemId: f.item.id })).toBe(0);
    await parts.updateItemUsage(f.req.id, f.item.id, { usageStatus: 'used' }, f.tech);
    const invoice = await f.invoice(true);
    await repo(db, 'ServiceOrder').update(f.order.id, { status: 'completed', paymentStatus: 'paid' });
    await settlement.trySettleOrder(f.order.id); await settlement.trySettleOrder(f.order.id);
    const credits = await db.query("SELECT amount, idempotency_key FROM wallet_transactions WHERE reference_type = 'SERVICE_ORDER' AND reference_id = $1", [f.order.id]);
    expect(credits).toEqual([{ amount: '140000', idempotency_key: `ONLINE_EARNING:ORDER_${f.order.id}` }]);
    expect(await repo(db, 'CustodyPayout').countBy({ invoiceId: invoice.id })).toBe(0);
    expect((await repo(db, 'Invoice').findOneByOrFail({ id: invoice.id })).grandTotal).toBe('350000');
  });
});
