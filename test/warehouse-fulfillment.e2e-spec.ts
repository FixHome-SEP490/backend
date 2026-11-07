// Real PostgreSQL 16 service supplied by the existing CI workflow only. No .env/shared DEV access.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { warehouseJwtConfig } from './warehouse-jwt-config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const runtime = createRequire(resolve('package.json'));
const load = (path: string, symbol: string) => runtime(`./dist/${path}.js`)[symbol];
const secret = 'w2-ci-only-jwt-secret-with-at-least-32-characters';
type Actor = { id: string; role: string; token: string };

describe.skipIf(process.env.CI !== 'true')('W2 real PostgreSQL / JWT / custody atomic fulfillment', () => {
  const schema = `warehouse_w2_e2e_${randomUUID().replaceAll('-', '')}`;
  let root: DataSource, db: DataSource, app: INestApplication, jwt: JwtService, parts: any, custody: any, fulfillment: any;
  const repo = (name: string) => db.getRepository(name);
  const save = (name: string, value: object) => repo(name).save(value);
  const call = (method: 'post' | 'patch' | 'get', path: string, actor?: Actor, body?: object) => {
    const req = request(app.getHttpServer())[method](path);
    if (actor) req.set('Authorization', `Bearer ${actor.token}`);
    return body ? req.send(body) : req;
  };
  beforeAll(async () => {
    // Fixed loopback CI identity. Never consume DATABASE_*, a URL, dotenv or the migration CLI.
    const connection = { type: 'postgres' as const, host: '127.0.0.1', port: 5432, username: 'postgres', password: 'postgres', database: 'fixhome', ssl: false, synchronize: false };
    root = await new DataSource(connection).initialize();
    if ((await root.query('SELECT current_database() AS name'))[0].name !== 'fixhome' || !/^warehouse_w2_e2e_[a-f0-9]{32}$/.test(schema)) throw new Error('Wrong CI fixture');
    await root.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
    await root.query(`CREATE SCHEMA "${schema}"`);
    db = await new DataSource({ ...connection, schema, extra: { max: 8, options: `-c search_path=${schema},public -c lock_timeout=5000 -c statement_timeout=15000` },
      entities: [resolve('dist/**/*.entity.js')], migrations: [resolve('dist/database/migrations/*.js')] }).initialize();
    // Same public-only finance exclusions as the existing private-schema app.e2e harness.
    db.migrations.splice(0, db.migrations.length, ...db.migrations.filter(m => ![
      'VoucherFundingLedger1792994400001', 'VoucherCampaignLifecycle1793116800000',
      'CashPaymentIntents1793293200000', 'TechnicianResponsibility1793293200001',
    ].includes(m.name)));
    await db.runMigrations();
    vi.stubEnv('P1_CUSTODY_ENABLED', 'false'); vi.stubEnv('PART_RETURNS_TRACKING_ENABLED', 'true');
    await db.query("UPDATE part_custody_activation SET enabled=true, activated_at='2026-01-01' WHERE id=1");
    const Core = load('modules/part-requests/warehouse-fulfillment.service', 'WarehouseFulfillmentService');
    const Custody = load('modules/part-requests/part-custody.service', 'PartCustodyService');
    const Parts = load('modules/part-requests/part-requests.service', 'PartRequestsService');
    fulfillment = new Core(); custody = new Custody(db, fulfillment);
    const Audit = load('modules/audit-log/audit-log.service', 'AuditLogService');
    const Notices = load('modules/notifications/notifications.service', 'NotificationsService');
    parts = new Parts(db, repo('PartRequest'), repo('PartRequestItem'), repo('FixHomePart'), new Audit(repo('AuditLog')), new Notices(repo('Notification')), custody, undefined, fulfillment);
    const User = load('modules/users/entities/user.entity', 'User');
    const JwtStrategy = load('modules/auth/strategies/jwt.strategy', 'JwtStrategy');
    const RolesGuard = load('common/guards/roles.guard', 'RolesGuard');
    const auth = warehouseJwtConfig(secret);
    const module = await Test.createTestingModule({ imports: [PassportModule, JwtModule.register({ secret: auth.secret })],
      controllers: [load('modules/part-requests/part-requests.controller', 'PartRequestsController'), load('modules/part-requests/part-returns.controller', 'PartReturnsController')],
      providers: [RolesGuard, JwtStrategy, { provide: getRepositoryToken(User), useValue: repo('User') },
        { provide: ConfigService, useValue: auth.config },
        { provide: Custody, useValue: custody }, { provide: Parts, useValue: parts }] }).compile();
    app = module.createNestApplication(); app.useLogger(false);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init(); jwt = module.get(JwtService);
  }, 60000);
  afterAll(async () => {
    if (app) await app.close(); if (db?.isInitialized) await db.destroy();
    if (root?.isInitialized) { await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await root.destroy(); }
    vi.unstubAllEnvs();
  }, 30000);

  async function fixture(quantities = [3, 2]) {
    const actor = async (role: string): Promise<Actor> => {
      const u = await save('User', { email: `${randomUUID()}@example.test`, passwordHash: 'ci-no-login', fullName: 'W2 synthetic actor', role, status: 'active', isActive: true });
      return { id: u.id, role, token: jwt.sign({ sub: u.id, role }) };
    };
    const tech = await actor('technician'), other = await actor('technician'), sm = await actor('service_manager'), wrong = await actor('service_manager'), customer = await actor('customer');
    const category = await save('ServiceCategory', { code: randomUUID(), name: 'W2 synthetic category' });
    const service = await save('Service', { categoryId: category.id, code: randomUUID(), name: 'W2 synthetic repair', pricingMode: 'fixed_price', fixedPrice: 100000 });
    const booking = await save('Booking', { customerId: customer.id, serviceId: service.id, description: 'W2 synthetic request', status: 'matched' });
    const order = await save('ServiceOrder', { bookingId: booking.id, code: `W2-${randomUUID()}`, status: 'accepted' });
    await save('TechnicianAssignment', { serviceOrderId: order.id, technicianId: tech.id, isActive: true });
    const catalog = await Promise.all(quantities.map(() => save('FixHomePart', { sku: randomUUID(), name: 'W2 synthetic SKU', sellingPrice: 50000 })));
    const warehouse = await save('Warehouse', { name: 'W2 synthetic warehouse', address: 'Synthetic address', responsibleUserId: sm.id, status: 'active' });
    for (const [i, part] of catalog.entries()) await save('WarehouseStock', { warehouseId: warehouse.id, partId: part.id, onHand: quantities[i], reserved: 0, version: 0 });
    const create = (who = tech) => call('post', `/service-orders/${order.id}/part-requests`, who,
      { items: catalog.map((p, i) => ({ partCatalogId: p.id, quantity: quantities[i] })), fulfillmentMethod: 'pickup' });
    const made = await create().expect(201); const req = made.body.data;
    const base = `/part-requests/${req.id}`;
    const balance = () => db.query('SELECT part_id,on_hand,reserved FROM warehouse_stock WHERE warehouse_id=$1 ORDER BY part_id', [warehouse.id]);
    const qr = async () => (await call('post', `${base}/warehouse-qr`, sm, { idempotencyKey: randomUUID() }).expect(200)).body.data.qrToken;
    const issue = async () => {
      const body = { idempotencyKey: randomUUID(), qrToken: await qr() };
      const result = await call('post', `${base}/warehouse-handover`, sm, body).expect(200);
      return { body, receipt: result.body.data.qrToken };
    };
    return { actor, tech, other, sm, wrong, customer, catalog, warehouse, order, req, base, balance, create, qr, issue };
  }

  it('reserves all SKUs at one warehouse, protects JWT/SM/tech, consumes two separate single-use QR phases and blocks new work before ACK', async () => {
    const f = await fixture();
    expect((await f.balance()).every(r => r.on_hand === r.reserved)).toBe(true);
    await call('get', `${f.base}/warehouse-allocation`).expect(401);
    await call('get', `${f.base}/warehouse-allocation`, f.customer).expect(403);
    await call('post', `${f.base}/warehouse-qr`, f.wrong, { idempotencyKey: randomUUID() }).expect(403);
    await call('post', `${f.base}/receive`, f.tech, { qrToken: 'not-issued' }).expect(409);
    const old = await f.qr(), token = await f.qr();
    await call('post', `${f.base}/warehouse-handover`, f.sm, { qrToken: old, idempotencyKey: randomUUID() }).expect(409);
    const key = randomUUID(), body = { qrToken: token, idempotencyKey: key };
    const issued = await call('post', `${f.base}/warehouse-handover`, f.sm, body).expect(200);
    const receipt = issued.body.data.qrToken;
    expect((await f.balance()).every(r => r.on_hand === 0 && r.reserved === 0)).toBe(true);
    const restriction = load('modules/part-requests/part-custody.policy', 'hasPartReturnRestriction');
    expect(await restriction(db.manager, f.tech.id)).toBe(true);
    expect((await repo('PartRequest').findOneByOrFail({ id: f.req.id })).receivedAt).toBeNull();
    expect((await call('post', `${f.base}/warehouse-handover`, f.sm, body).expect(200)).body.data.qrToken).toBeNull();
    await call('post', `${f.base}/warehouse-handover`, f.sm, { ...body, qrToken: 'a'.repeat(64) }).expect(409);
    await call('post', `${f.base}/receive`, f.other, { qrToken: receipt }).expect(403);
    // Lost response recovery rotates only the receipt; the old receipt is invalid immediately.
    const before = await f.balance(), recovered = await f.qr();
    expect(await f.balance()).toEqual(before);
    await call('post', `${f.base}/receive`, f.tech, { qrToken: receipt }).expect(409);
    await call('post', `${f.base}/receive`, f.tech, { qrToken: recovered }).expect(200);
    await call('post', `${f.base}/receive`, f.tech, { qrToken: recovered }).expect(409);
    expect(await db.query('SELECT * FROM warehouse_fulfillment_movements WHERE kind=\'ISSUE\' AND warehouse_id=$1', [f.warehouse.id])).toHaveLength(f.catalog.length);
    const redacted = (await call('get', `${f.base}/warehouse-allocation`, f.wrong).expect(200)).body.data;
    expect(JSON.stringify(redacted)).not.toContain(recovered); expect(redacted).not.toHaveProperty('receiptHash');
    expect((await repo('ServiceOrder').findOneByOrFail({ id: f.order.id })).grandTotal).toBe('0');
  });

  it('refuses A+B split and notifies the technician to self-prepare with no reservation or QR', async () => {
    const f = await fixture([1, 1]);
    await call('patch', `${f.base}/cancel`, f.tech, { reason: 'Synthetic cancellation' }).expect(200);
    const second = await save('Warehouse', { name: 'W2 B', responsibleUserId: f.sm.id, status: 'active' });
    await repo('WarehouseStock').update({ warehouseId: f.warehouse.id, partId: f.catalog[1].id }, { onHand: 0 });
    await save('WarehouseStock', { warehouseId: second.id, partId: f.catalog[1].id, onHand: 1, reserved: 0 });
    const r = (await f.create().expect(201)).body.data;
    const a = await repo('WarehouseAllocation').findOneByOrFail({ partRequestId: r.id });
    expect(a).toMatchObject({ status: 'manual_assistance', warehouseId: null });
    expect(await db.query('SELECT * FROM warehouse_fulfillment_movements m JOIN warehouse_fulfillment_commands c ON c.id=m.command_id WHERE c.part_request_id=$1', [r.id])).toHaveLength(0);
    const unavailable = (await call('get', `${f.base}/warehouse-allocation`, f.tech).expect(200)).body.data;
    expect(unavailable).toMatchObject({ status: 'stock_unavailable', warehouseId: null, stockUnavailable: true });
    expect(await repo('Notification').countBy({ referenceId: r.id, type: 'PART_REQUEST_STOCK_UNAVAILABLE', userId: f.tech.id })).toBe(1);
    expect(await repo('Notification').countBy({ referenceId: r.id, type: 'PART_REQUEST_MANUAL_ASSISTANCE' })).toBe(0);
    await call('post', `${f.base}/warehouse-reserve`, f.sm, { idempotencyKey: randomUUID() }).expect(409);
  });

  it('serializes two distinct requests racing for the last units: exactly one wins', async () => {
    const f = await fixture([2]);
    await call('patch', `${f.base}/cancel`, f.tech, { reason: 'Synthetic cancellation' }).expect(200);
    const secondTech = await f.actor('technician');
    const old = await repo('Booking').findOneByOrFail({ id: f.order.bookingId });
    const b = await save('Booking', { customerId: old.customerId, serviceId: old.serviceId, description: 'W2 race', status: 'matched' });
    const order = await save('ServiceOrder', { bookingId: b.id, code: `W2-${randomUUID()}`, status: 'accepted' });
    await save('TechnicianAssignment', { serviceOrderId: order.id, technicianId: secondTech.id, isActive: true });
    const responses = await Promise.all([f.create(), call('post', `/service-orders/${order.id}/part-requests`, secondTech,
      { items: [{ partCatalogId: f.catalog[0].id, quantity: 2 }], fulfillmentMethod: 'pickup' })]);
    expect(responses.map(r => r.status)).toEqual([201, 201]);
    const states = await Promise.all(responses.map(r => repo('WarehouseAllocation').findOneByOrFail({ partRequestId: r.body.data.id })));
    expect(states.map(a => a.status).sort()).toEqual(['manual_assistance', 'reserved']);
    expect(await f.balance()).toMatchObject([{ on_hand: 2, reserved: 2 }]);
  });

  it('expires pickup and receipt QR without issue/reissue and fails closed when activation is off', async () => {
    const f = await fixture([1]); const token = await f.qr();
    await repo('WarehouseAllocation').update({ partRequestId: f.req.id }, { tokenExpiresAt: new Date(0) });
    await call('post', `${f.base}/warehouse-handover`, f.sm, { qrToken: token, idempotencyKey: randomUUID() }).expect(409);
    const newToken = await f.qr();
    await db.query('UPDATE part_custody_activation SET enabled=false WHERE id=1');
    try { await call('post', `${f.base}/warehouse-handover`, f.sm, { qrToken: newToken, idempotencyKey: randomUUID() }).expect(409); }
    finally { await db.query('UPDATE part_custody_activation SET enabled=true WHERE id=1'); }
    expect(await f.balance()).toMatchObject([{ on_hand: 1, reserved: 1 }]);
    const issued = await f.issue();
    await repo('WarehouseAllocation').update({ partRequestId: f.req.id }, { receiptExpiresAt: new Date(0) });
    await call('post', `${f.base}/receive`, f.tech, { qrToken: issued.receipt }).expect(409);
    expect(await f.balance()).toMatchObject([{ on_hand: 0, reserved: 0 }]);
  });

  it('accepts unused physical returns through existing custody once; rejects wrong SM, changed replay, overreturn and used restock', async () => {
    const f = await fixture([3]); const issued = await f.issue();
    await call('post', `${f.base}/receive`, f.tech, { qrToken: issued.receipt }).expect(200);
    await repo('ServiceOrder').update(f.order.id, { status: 'under_repair' });
    const [item] = await repo('PartRequestItem').findBy({ partRequestId: f.req.id });
    const path = `${f.base}/items/${item.id}`;
    // Zero-used is a real custody decision, with two declared units leaving one unresolved.
    await call('patch', `${path}/usage`, f.tech, { usageStatus: 'returned', usedQty: 0, expectedVersion: 0, idempotencyKey: 'w2-usage-zero' }).expect(200);
    await call('post', `${path}/declare-return`, f.tech, { quantity: 2, expectedVersion: 1, idempotencyKey: 'w2-declare-two' }).expect(200);
    expect(await f.balance()).toMatchObject([{ on_hand: 0, reserved: 0 }]);
    const body = { quantity: 2, expectedVersion: 2, idempotencyKey: 'w2-accept-two' };
    await call('post', `${path}/accept-return`, f.wrong, body).expect(403);
    await db.query(`CREATE FUNCTION w2_reject_return() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind='RETURN' THEN RAISE EXCEPTION 'W2 injected return failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER w2_inject_return BEFORE INSERT ON warehouse_fulfillment_movements FOR EACH ROW EXECUTE FUNCTION w2_reject_return()`);
    try { await call('post', `${path}/accept-return`, f.sm, body).expect(500); }
    finally { await db.query('DROP TRIGGER w2_inject_return ON warehouse_fulfillment_movements; DROP FUNCTION w2_reject_return()'); }
    expect(await f.balance()).toMatchObject([{ on_hand: 0, reserved: 0 }]);
    expect((await repo('PartCustody').findOneByOrFail({ partRequestItemId: item.id })).state.managerAcceptedQty).toBe(0);
    await call('post', `${path}/accept-return`, f.sm, body).expect(200);
    await call('post', `${path}/accept-return`, f.sm, body).expect(200);
    expect(await f.balance()).toMatchObject([{ on_hand: 2, reserved: 0 }]);
    await call('post', `${path}/accept-return`, f.sm, { ...body, quantity: 1 }).expect(409);
    await call('post', `${path}/accept-return`, f.sm, { quantity: 2, expectedVersion: 3, idempotencyKey: 'w2-overreturn' }).expect(409);
    const quote = await save('Quotation', { serviceOrderId: f.order.id, technicianId: f.tech.id, status: 'approved' });
    await save('QuotationItem', { quotationId: quote.id, type: 'parts_equipment', description: 'W2 synthetic approved unit', partSource: 'fixhome', partCatalogId: f.catalog[0].id, quantity: 1, unitPrice: 50000, lineTotal: 50000 });
    await call('patch', `${path}/usage`, f.tech, { usageStatus: 'used', usedQty: 1, expectedVersion: 3, idempotencyKey: 'w2-used-one' }).expect(200);
    await call('post', `${path}/declare-return`, f.tech, { quantity: 1, expectedVersion: 4, idempotencyKey: 'w2-declare-used' }).expect(409);
    expect(await f.balance()).toMatchObject([{ on_hand: 2, reserved: 0 }]);
  });

  it('rolls back physical issue and custody if immutable movement insertion fails', async () => {
    const f = await fixture([2]); const token = await f.qr();
    await db.query(`CREATE FUNCTION w2_reject_issue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind='ISSUE' THEN RAISE EXCEPTION 'W2 injected issue failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER w2_inject_issue BEFORE INSERT ON warehouse_fulfillment_movements FOR EACH ROW EXECUTE FUNCTION w2_reject_issue()`);
    try { await call('post', `${f.base}/warehouse-handover`, f.sm, { qrToken: token, idempotencyKey: randomUUID() }).expect(500); }
    finally { await db.query('DROP TRIGGER w2_inject_issue ON warehouse_fulfillment_movements; DROP FUNCTION w2_reject_issue()'); }
    expect(await f.balance()).toMatchObject([{ on_hand: 2, reserved: 2 }]);
    expect(await repo('PartCustody').countBy({ partRequestId: f.req.id })).toBe(0);
    expect((await repo('WarehouseAllocation').findOneByOrFail({ partRequestId: f.req.id })).status).toBe('ready');
  });

  it('requires actual ISSUE ledger for pre-ACK custody admission and preserves unallocated legacy receive evidence', async () => {
    const f = await fixture([1]); await f.qr();
    const at = new Date();
    await expect(db.transaction(async manager => {
      await manager.query('SELECT id FROM service_orders WHERE id=$1 FOR UPDATE', [f.order.id]);
      // Adversarial evidence with no ISSUE movement must NEVER authorize enrollment.
      await manager.getRepository('WarehouseAllocation').update({ partRequestId: f.req.id },
        { status: 'handed_over', handedOverAt: at, handedOverBy: f.sm.id });
      const req = await manager.getRepository('PartRequest').findOneOrFail({ where: { id: f.req.id }, relations: ['items'] });
      await custody.enrollHandover(manager, { ...req, receivedAt: at }, f.order);
    })).rejects.toThrow('eligible post-activation handover');
    expect(await repo('PartCustody').countBy({ partRequestId: f.req.id })).toBe(0);
    expect(await f.balance()).toMatchObject([{ on_hand: 1, reserved: 1 }]);
    // One active PRE_REPAIR per order is a real invariant. Give the legacy receipt its own order.
    const sourceBooking = await repo('Booking').findOneByOrFail({ id: f.order.bookingId });
    const legacyBooking = await save('Booking', { customerId: sourceBooking.customerId, serviceId: sourceBooking.serviceId,
      description: 'W2 isolated legacy receipt', status: 'matched' });
    const legacyOrder = await save('ServiceOrder', { bookingId: legacyBooking.id, code: `W2-legacy-${randomUUID()}`, status: 'accepted' });
    const legacy = await save('PartRequest', { serviceOrderId: legacyOrder.id, technicianId: f.tech.id,
      requestType: 'pre_repair', fulfillmentMethod: 'pickup', status: 'received', receivedAt: new Date() });
    legacy.items = [await save('PartRequestItem', { partRequestId: legacy.id, partCatalogId: f.catalog[0].id,
      partSource: 'fixhome', partNameSnapshot: 'W2 synthetic legacy', quantity: 1, unitPriceSnapshot: 50000 })];
    const before = await f.balance();
    await db.transaction(manager => custody.enrollHandover(manager, legacy, legacyOrder));
    expect(await repo('PartCustody').countBy({ partRequestId: legacy.id })).toBe(1);
    expect(await repo('WarehouseAllocation').countBy({ partRequestId: legacy.id })).toBe(0);
    expect(await f.balance()).toEqual(before);
  });

  it('releases through order close, failed-repair utility and reassignment once, preserving physically issued inventory', async () => {
    const close = load('modules/part-requests/part-request-lifecycle', 'closeOrderPartRequests');
    const outgoing = load('modules/part-requests/part-request-lifecycle', 'releaseOutgoingTechnicianPartRequests');
    const release = load('modules/part-requests/warehouse-fulfillment.service', 'releaseWarehouseReservations');
    for (const operation of ['close', 'failed', 'outgoing']) {
      const f = await fixture([2]);
      const command = () => db.transaction(async manager => {
        await manager.query('SELECT id FROM service_orders WHERE id=$1 FOR UPDATE', [f.order.id]);
        if (operation === 'close') await close(manager, f.order.id, true);
        else if (operation === 'outgoing') await outgoing(manager, f.order.id, f.tech.id);
        else await release(manager, { serviceOrderId: f.order.id });
      });
      await command(); await command();
      expect(await f.balance()).toMatchObject([{ on_hand: 2, reserved: 0 }]);
      expect((await repo('WarehouseAllocation').findOneByOrFail({ partRequestId: f.req.id })).status).toBe('released');
    }
    const f = await fixture([2]); await f.issue();
    await db.transaction(async manager => {
      await manager.query('SELECT id FROM service_orders WHERE id=$1 FOR UPDATE', [f.order.id]);
      await close(manager, f.order.id, true); await outgoing(manager, f.order.id, f.tech.id);
    });
    expect(await f.balance()).toMatchObject([{ on_hand: 0, reserved: 0 }]);
    expect((await repo('WarehouseAllocation').findOneByOrFail({ partRequestId: f.req.id })).status).toBe('handed_over');
  });
});
