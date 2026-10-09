import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Session = { accessToken: string; user: { id: string } };
type Context = { app: INestApplication; db: DataSource; register: () => Promise<Session>; provisionTechnician: () => Promise<Session> };
const runtimeRequire = createRequire(resolve('package.json'));
const unwrap = (body: any): any => body?.data !== undefined ? unwrap(body.data) : body;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

/** Real HTTP/JWT/RBAC/Postgres; only the external Supabase transport is mocked. */
export function registerDev1Cases(context: () => Context) {
  describe('DEV1 booking and order business regression', () => {
    let storage: any;
    // These cases walk orders booked two days ahead; setting out opens one hour before
    // the appointment (PO 08/10/2026), so the window is widened here and the rule itself
    // has its own case below.
    const setDepartEarlyMinutes = async (minutes: number) => {
      const { BusinessConfigService } = runtimeRequire('./dist/modules/system-config/business-config.service.js');
      await context().db.query(`UPDATE "system_configs" SET "value" = $1 WHERE "key" = 'order.depart_early_minutes'`, [String(minutes)]);
      context().app.get(BusinessConfigService).invalidateCache();
    };
    beforeAll(async () => {
      await setDepartEarlyMinutes(100000);
      const { OrderEvidenceStorage } = runtimeRequire('./dist/modules/media/order-evidence-storage.service.js');
      storage = context().app.get(OrderEvidenceStorage);
      vi.spyOn(storage, 'upload').mockImplementation(async (order: any, owner: any) => `storage://test/${order}/${owner}/${randomUUID()}`);
      vi.spyOn(storage, 'signedUrl').mockResolvedValue('https://storage.example.test/signed-test-object');
    });
    afterAll(() => vi.restoreAllMocks());
    const post = (path: string, session: Session, body: object = {}) => request(context().app.getHttpServer()).post(`/api/v1${path}`).set('Authorization', `Bearer ${session.accessToken}`).send(body);
    const get = (path: string, session: Session) => request(context().app.getHttpServer()).get(`/api/v1${path}`).set('Authorization', `Bearer ${session.accessToken}`);
    const patch = (path: string, session: Session, body: object = {}) => request(context().app.getHttpServer()).patch(`/api/v1${path}`).set('Authorization', `Bearer ${session.accessToken}`).send(body);
    const save = (entity: string, data: object) => context().db.getRepository(entity).save(data);
    const denied = (response: request.Response) => expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
    async function fixture(pricingMode = 'fixed_price') {
      const { db, register, provisionTechnician } = context();
      const owner = await register(), outsider = await register();
      const tech = await provisionTechnician(), spare = await provisionTechnician();
      const category = await save('ServiceCategory', { name: 'DEV1 fixture', code: randomUUID() });
      const service = await save('Service', { categoryId: category.id, name: 'Repair fixture', code: randomUUID(), pricingMode, fixedPrice: pricingMode === 'fixed_price' ? 200000 : null, scopeDescription: 'Fixture scope', unit: 'job' });
      const address = await save('Address', { userId: owner.user.id, line1: '1 Test Street', district: 'D1', province: 'P1', lat: 10.77, lng: 106.69 });
      for (const actor of [tech, spare]) {
        const profile = await db.getRepository('TechnicianProfile').findOneByOrFail({ userId: actor.user.id });
        await db.getRepository('TechnicianProfile').update(profile.id, { verificationStatus: 'verified', isAvailable: true });
        await save('TechnicianSkill', { technicianId: profile.id, serviceId: service.id, listedLaborPrice: 100000, verificationStatus: 'verified' });
        await save('Address', { userId: actor.user.id, line1: 'Tech shop', district: 'D1', province: 'P1', lat: 10.77, lng: 106.69, isDefault: true });
        for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) await save('TechnicianSchedule', { technicianId: profile.id, dayOfWeek, startTime: '08:00', endTime: '18:00' });
      }
      const start = new Date(); start.setUTCDate(start.getUTCDate() + 2); start.setUTCHours(1, 0, 0, 0);
      const body = { serviceId: service.id, addressId: address.id, description: 'Repair the fixture', quantity: 2, preferredStartAt: start.toISOString(), preferredEndAt: new Date(+start + 3600000).toISOString() };
      const create = async () => { const response = await post('/bookings', owner, body); expect(response.status, JSON.stringify(response.body)).toBe(201); return unwrap(response.body); };
      return { owner, outsider, tech, spare, service, address, body, create };
    }
    async function accept(f: Awaited<ReturnType<typeof fixture>>, booking?: any) {
      booking ??= await f.create();
      await post(`/bookings/${booking.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id, f.spare.user.id] }).expect(201);
      const invitation = await context().db.getRepository('BookingInvitation').findOneByOrFail({ bookingId: booking.id, status: 'pending' });
      const result = unwrap((await post(`/invitations/${invitation.id}/respond`, f.tech, { action: 'ACCEPT' }).expect(200)).body);
      return { order: result.serviceOrder, invitation, booking };
    }
    const evidence = (orderId: string, actor: Session, type: string) => request(context().app.getHttpServer()).post(`/api/v1/service-orders/${orderId}/evidence`).set('Authorization', `Bearer ${actor.accessToken}`).field('type', type).attach('file', png, { filename: 'evidence.png', contentType: 'image/png' });
    async function arrived(orderId: string, actor: Session) {
      await post(`/service-orders/${orderId}/en-route`, actor).expect(200);
      const result = unwrap((await post(`/service-orders/${orderId}/check-in`, actor, { lat: 10.77, lng: 106.69, accuracyMeters: 5 }).expect(200)).body);
      expect(result.result).toBe('valid');
      await evidence(orderId, actor, 'before').expect(201);
    }

    it('validates booking DTO, address ownership, snapshots and creates no pre-Accept order', async () => {
      const f = await fixture();
      for (const changes of [{ preferredEndAt: undefined }, { quantity: 0 }, { quantity: 1.5 }, { preferredStartAt: '2020-01-01T00:00:00Z' }, { description: '  ' }, { status: 'matched' }]) denied(await post('/bookings', f.owner, { ...f.body, ...changes }));
      denied(await post('/bookings', f.outsider, f.body));
      denied(await post('/bookings', f.tech, f.body));
      const b = await f.create();
      expect(b.fixedUnitPriceSnapshot).toBe('200000.00');
      expect(await context().db.getRepository('ServiceOrder').count({ where: { bookingId: b.id } })).toBe(0);
      await context().db.getRepository('Address').update(f.address.id, { line1: 'Changed later' });
      const read = unwrap((await get(`/bookings/${b.id}`, f.owner).expect(200)).body);
      expect(read.addressTextSnapshot).toContain('1 Test Street');
      denied(await get(`/bookings/${b.id}`, f.outsider));
      denied(await post(`/bookings/${b.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id, f.tech.user.id] }));
    });

    it('serializes duplicate Accept and rejects overlapping assignments across bookings', async () => {
      const f = await fixture(), b = await f.create(), b2 = await f.create();
      for (const booking of [b, b2]) await post(`/bookings/${booking.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id, f.spare.user.id] }).expect(201);
      const invitations = await context().db.getRepository('BookingInvitation').find({ where: { technicianId: f.tech.user.id, status: 'pending' } });
      const results = await Promise.all(invitations.map(i => post(`/invitations/${i.id}/respond`, f.tech, { action: 'ACCEPT' })));
      expect(results.filter(r => r.status === 200)).toHaveLength(1);
      const accepted = invitations[results.findIndex(r => r.status === 200)];
      const repeat = await Promise.all([1, 2].map(() => post(`/invitations/${accepted.id}/respond`, f.tech, { action: 'ACCEPT' }).expect(200)));
      expect(unwrap(repeat[0].body).serviceOrder.id).toBe(unwrap(repeat[1].body).serviceOrder.id);
      expect(await context().db.getRepository('TechnicianAssignment').count({ where: { technicianId: f.tech.user.id, isActive: true } })).toBe(1);
    });

    it('declines without strikes, expires sequential invitations and permits fresh reselection', async () => {
      const f = await fixture(), b = await f.create(), repo = context().db.getRepository('BookingInvitation');
      await post(`/bookings/${b.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id, f.spare.user.id] }).expect(201);
      const first = await repo.findOneByOrFail({ bookingId: b.id, status: 'pending' });
      denied(await post(`/invitations/${first.id}/respond`, f.spare, { action: 'ACCEPT' }));
      await post(`/invitations/${first.id}/respond`, f.tech, { action: 'DECLINE' }).expect(200);
      const second = await repo.findOneByOrFail({ bookingId: b.id, status: 'pending' });
      expect(second.technicianId).toBe(f.spare.user.id);
      await repo.update(second.id, { expiresAt: new Date(Date.now() - 1000) });
      expect(unwrap((await get(`/bookings/${b.id}`, f.owner).expect(200)).body).status).toBe('closed');
      await post(`/bookings/${b.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id, f.spare.user.id] }).expect(201);
      expect(await repo.count({ where: { bookingId: b.id } })).toBe(4);
      expect(await context().db.getRepository('CancellationStrike').count({ where: { userId: f.tech.user.id } })).toBe(0);
    });

    it('rematches before-arrival withdrawal on the same order and preserves assignment history', async () => {
      const f = await fixture(), booking = await f.create();
      await post(`/bookings/${booking.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id, f.spare.user.id] }).expect(201);
      const repo = context().db.getRepository('BookingInvitation');
      const first = await repo.findOneByOrFail({ bookingId: booking.id, status: 'pending' });
      const order = unwrap((await post(`/invitations/${first.id}/respond`, f.tech, { action: 'ACCEPT' }).expect(200)).body).serviceOrder;
      await post(`/service-orders/${order.id}/cancel`, f.tech, { reason: 'Unable to travel' }).expect(200);
      const next = await repo.findOneByOrFail({ bookingId: booking.id, status: 'pending' });
      expect(next.technicianId).toBe(f.spare.user.id);
      const replacement = unwrap((await post(`/invitations/${next.id}/respond`, f.spare, { action: 'ACCEPT' }).expect(200)).body).serviceOrder;
      expect(replacement.id).toBe(order.id);
      const assignments = await context().db.getRepository('TechnicianAssignment').find({ where: { serviceOrderId: order.id } });
      expect(assignments).toHaveLength(2);
      expect(assignments.filter(a => a.isActive)).toHaveLength(1);
      denied(await post(`/service-orders/${order.id}/en-route`, f.tech));
      await post(`/service-orders/${order.id}/en-route`, f.spare).expect(200);
    });

    it('costs reputation points when a customer or technician cancels a held order, never for staff (PO 08/10/2026)', async () => {
      const f = await fixture(), db = context().db;
      const points = async (userId: string) => Number((await db.query('SELECT reputation_points FROM users WHERE id = $1', [userId]))[0].reputation_points);
      // Customer cancels an order a technician holds: -10, recorded with the cancellation.
      const first = await accept(f);
      await post(`/service-orders/${first.order.id}/cancel`, f.owner, { reason: 'Đổi ý' }).expect(200);
      expect(await points(f.owner.user.id)).toBe(90);
      const [event] = await db.query('SELECT kind, delta, points_after, cancellation_id, service_order_id FROM reputation_events WHERE user_id = $1', [f.owner.user.id]);
      expect(event).toMatchObject({ kind: 'violation', delta: -10, points_after: 90, service_order_id: first.order.id });
      expect(event.cancellation_id).toBeTruthy();
      expect(unwrap((await get('/users/me', f.owner).expect(200)).body).reputationPoints).toBe(90);
      const mine = unwrap((await get('/reputation/me', f.owner).expect(200)).body);
      expect(mine).toMatchObject({ points: 90, suspendedUntil: null, locked: false });
      expect(mine.events).toHaveLength(1);
      expect(new Date(mine.resetsAt).getTime()).toBeGreaterThan(Date.now());
      // Technician withdraws before arrival: -10 for the technician, the customer keeps 90.
      const second = await accept(f);
      await post(`/service-orders/${second.order.id}/cancel`, f.tech, { reason: 'Kẹt xe' }).expect(200);
      expect(await points(f.tech.user.id)).toBe(90);
      expect(await points(f.owner.user.id)).toBe(90);
      // Staff cancellations cost nobody points.
      const manager = await context().register();
      await db.query('UPDATE users SET role = $1 WHERE id = $2', ['service_manager', manager.user.id]);
      const third = await accept(f, await f.create());
      await post(`/service-orders/${third.order.id}/cancel`, manager, { reason: 'Khách nhờ huỷ hộ' }).expect(200);
      expect(await points(f.owner.user.id)).toBe(90);
      // The review list shows what each cancellation cost; violations are no longer confirmed by hand (PO 09/10/2026).
      const cancellations = unwrap((await get('/cancellations?pageSize=100', manager).expect(200)).body);
      const costOf = (orderId: string) => cancellations.find((c: any) => c.serviceOrderId === orderId)?.reputationDelta;
      expect(costOf(first.order.id)).toBe(-10);
      expect(costOf(second.order.id)).toBe(-10);
      expect(costOf(third.order.id)).toBeNull();
      const customerCancel = cancellations.find((c: any) => c.serviceOrderId === first.order.id);
      expect((await post(`/cancellations/${customerCancel.id}/review`, manager, { confirmViolation: true })).status).toBe(422);
    });

    it('bans a customer below 70 points and lets only staff read and adjust the score (PO 08/10/2026)', async () => {
      const f = await fixture(), db = context().db;
      const points = async (userId: string) => Number((await db.query('SELECT reputation_points FROM users WHERE id = $1', [userId]))[0].reputation_points);
      const manager = await context().register();
      await db.query('UPDATE users SET role = $1 WHERE id = $2', ['service_manager', manager.user.id]);
      // Below 70 the customer cannot book for 72 hours.
      await db.query('UPDATE users SET reputation_points = 70 WHERE id = $1', [f.owner.user.id]);
      const fourth = await accept(f);
      await post(`/service-orders/${fourth.order.id}/cancel`, f.owner, { reason: 'Đổi ý lần nữa' }).expect(200);
      expect(await points(f.owner.user.id)).toBe(60);
      const [{ booking_suspended_until: until }] = await db.query('SELECT booking_suspended_until FROM users WHERE id = $1', [f.owner.user.id]);
      expect(Math.round((new Date(until).getTime() - Date.now()) / 3600000)).toBe(72);
      denied(await post('/bookings', f.owner, f.body));
      expect(unwrap((await get('/reputation/me', f.owner).expect(200)).body).suspendedUntil).toBeTruthy();
      denied(await get('/reputation/me', manager));
      // Staff see the lowest scores first, read why, and adjust with a reason; others cannot.
      denied(await get('/reputation', f.owner));
      denied(await post(`/reputation/${f.owner.user.id}/adjust`, f.tech, { delta: 10, reason: 'Tự cộng điểm' }));
      const page = (await get('/reputation?role=customer&pageSize=50', manager).expect(200)).body;
      expect(page.meta).toMatchObject({ page: 1, limit: 50 });
      expect(page.meta.total).toBeGreaterThanOrEqual(1);
      const listed = unwrap(page);
      expect(listed.find((row: any) => row.id === f.owner.user.id)?.reputationPoints).toBe(60);
      expect(unwrap((await get(`/reputation/${f.owner.user.id}/events`, manager).expect(200)).body)).toHaveLength(1);
      denied(await post(`/reputation/${f.owner.user.id}/adjust`, manager, { delta: 0, reason: 'Không đổi gì' }));
      denied(await post(`/reputation/${f.owner.user.id}/adjust`, manager, { delta: 10, reason: '' }));
      denied(await post(`/reputation/${manager.user.id}/adjust`, manager, { delta: -10, reason: 'Trừ điểm quản lý' }));
      const adjusted = unwrap((await post(`/reputation/${f.owner.user.id}/adjust`, manager, { delta: 20, reason: 'Thợ đến trễ nên khách huỷ' }).expect(200)).body);
      expect(adjusted.points).toBe(80);
      expect((await db.query('SELECT booking_suspended_until FROM users WHERE id = $1', [f.owner.user.id]))[0].booking_suspended_until).toBeNull();
      await post('/bookings', f.owner, f.body).expect(201);
    });

    it('moves an accepted order to a session its technician is free for, tells them, and refuses a taken one (PO 08/10/2026)', async () => {
      const f = await fixture(), db = context().db;
      const day = new Date(Date.now() + 7 * 3600000 + 3 * 86400000).toISOString().slice(0, 10);
      const first = await accept(f);
      await patch(`/bookings/${first.booking.id}/schedule`, f.owner, { mode: 'scheduled', date: day, slot: 'afternoon' }).expect(200);
      const [order] = await db.query('SELECT scheduled_at FROM service_orders WHERE id = $1', [first.order.id]);
      expect(new Date(order.scheduled_at).toISOString()).toBe(`${day}T06:00:00.000Z`);
      const notices = await db.query("SELECT message FROM notifications WHERE user_id = $1 AND type = 'BOOKING_RESCHEDULED'", [f.tech.user.id]);
      expect(notices).toHaveLength(1);
      expect(notices[0].message).toContain('Buổi chiều');
      // The same technician takes the morning of that day on another booking; that session is now theirs.
      const morning = await post('/bookings', f.owner, { ...f.body, preferredStartAt: undefined, preferredEndAt: undefined, mode: 'scheduled', date: day, slot: 'morning' });
      expect(morning.status, JSON.stringify(morning.body)).toBe(201);
      await accept(f, unwrap(morning.body));
      denied(await patch(`/bookings/${first.booking.id}/schedule`, f.owner, { mode: 'scheduled', date: day, slot: 'morning' }));
      denied(await patch(`/bookings/${first.booking.id}/schedule`, f.owner, { mode: 'urgent' }));
      const slots = unwrap((await get(`/bookings/${first.booking.id}/available-slots?days=5`, f.owner).expect(200)).body);
      const taken = slots.sessions.find((s: any) => s.date === day && s.slot === 'morning');
      expect(taken).toMatchObject({ available: false });
    });

    it('pays an invoice from the customer wallet, settles like an online payment and refunds into the wallet (PO 08/10/2026)', async () => {
      const f = await fixture(), db = context().db, { order } = await accept(f), path = `/service-orders/${order.id}`;
      await post(path + '/en-route', f.tech).expect(200);
      await post(path + '/check-in', f.tech, { lat: 10.77, lng: 106.69, accuracyMeters: 5 }).expect(200);
      await evidence(order.id, f.tech, 'before').expect(201);
      await evidence(order.id, f.tech, 'after').expect(201);
      await post(path + '/request-completion', f.tech).expect(200);
      await post(path + '/confirm-completion', f.owner).expect(200);
      const invoice = unwrap((await get(path + '/invoice', f.owner).expect(200)).body);
      const total = Number(invoice.grandTotal);
      expect(total).toBe(400000);
      // Empty wallet: refused, nothing moves.
      denied(await post(`/invoices/${invoice.id}/pay-with-wallet`, f.owner));
      expect(unwrap((await get('/customer/wallet', f.owner).expect(200)).body)).toMatchObject({ balance: 0 });
      // Money already in the wallet (a VNPay top-up is not reachable from CI).
      await db.query('INSERT INTO customer_wallets (user_id, balance) VALUES ($1, $2)', [f.owner.user.id, 1000000]);
      denied(await post(`/invoices/${invoice.id}/pay-with-wallet`, f.outsider));
      denied(await post(`/invoices/${invoice.id}/pay-with-wallet`, f.tech));
      const paid = unwrap((await post(`/invoices/${invoice.id}/pay-with-wallet`, f.owner).expect(200)).body);
      expect(paid).toMatchObject({ paid: true, amount: total, balance: 600000 });
      denied(await post(`/invoices/${invoice.id}/pay-with-wallet`, f.owner));
      expect(unwrap((await get(path, f.owner).expect(200)).body).status).toBe('completed');
      const [due] = await db.query('SELECT status FROM commission_dues WHERE service_order_id = $1', [order.id]);
      expect(due.status).toBe('paid');
      expect(await db.query('SELECT 1 FROM platform_dues WHERE service_order_id = $1', [order.id])).toHaveLength(0);
      const earning = await db.query("SELECT t.type FROM wallet_transactions t JOIN wallets w ON w.id = t.wallet_id WHERE w.technician_id = $1 AND t.reference_id = $2", [f.tech.user.id, order.id]);
      expect(earning.map((t: any) => t.type)).toContain('ONLINE_EARNING');
      const [payment] = await db.query("SELECT provider, status FROM payments WHERE invoice_id = $1 AND status = 'verified'", [invoice.id]);
      expect(payment).toMatchObject({ provider: 'wallet', status: 'verified' });
      // A complaint resolved as a refund puts money back into the wallet, never more than was paid.
      const opened = await post('/support/cases', f.owner, { caseType: 'quality', reason: 'Máy vẫn kêu sau khi sửa', serviceOrderId: order.id });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const caseId = unwrap(opened.body).id;
      const manager = await context().register();
      await db.query('UPDATE users SET role = $1 WHERE id = $2', ['service_manager', manager.user.id]);
      denied(await post(`/support/cases/${caseId}/resolve`, manager, { finalStatus: 'resolved', resolutionCode: 'refund_to_wallet', reason: 'Hoàn một phần vì sửa chưa đạt', amount: total + 1 }));
      denied(await post(`/support/cases/${caseId}/resolve`, manager, { finalStatus: 'resolved', resolutionCode: 'refund_to_wallet', reason: 'Hoàn một phần vì sửa chưa đạt' }));
      await post(`/support/cases/${caseId}/resolve`, manager, { finalStatus: 'resolved', resolutionCode: 'refund_to_wallet', reason: 'Hoàn một phần vì sửa chưa đạt', amount: 150000 }).expect(200);
      const wallet = unwrap((await get('/customer/wallet', f.owner).expect(200)).body);
      expect(wallet.balance).toBe(750000);
      expect(wallet.transactions.map((t: any) => t.type)).toEqual(['refund', 'invoice_payment']);
      const second = unwrap((await post('/support/cases', f.owner, { caseType: 'quality', reason: 'Vẫn chưa ổn', serviceOrderId: order.id }).expect(201)).body).id;
      denied(await post(`/support/cases/${second}/resolve`, manager, { finalStatus: 'resolved', resolutionCode: 'refund_to_wallet', reason: 'Hoàn thêm phần còn lại của đơn', amount: total - 150000 + 1 }));
      denied(await get('/customer/wallet', f.tech));
    });

    it('enforces ownership, valid GPS, file evidence, completion and cash gates end-to-end', async () => {
      const f = await fixture(), { order } = await accept(f), path = `/service-orders/${order.id}`;
      await get('/technicians/me/profile', f.owner).expect(403);
      await get('/technicians/me/profile', f.tech).expect(200);
      for (const route of ['', '/evidence', '/invoice', '/warranties', '/cash-settlement', '/quotations', '/additional-costs']) denied(await get(path + route, f.outsider));
      denied(await post(path + '/en-route', f.spare));
      denied(await post(path + '/start-repair', f.tech));
      denied(await post(path + '/complete', f.tech));
      await post(path + '/en-route', f.tech).expect(200);
      denied(await patch(path + '/location', f.outsider, { lat: 10.77, lng: 106.69 }));
      denied(await patch(path + '/location', f.owner, { lat: 10.77, lng: 106.69 }));
      const ping = unwrap((await patch(path + '/location', f.tech, { lat: 10.75, lng: 106.68 }).expect(200)).body);
      expect(ping.lat).toBe(10.75);
      expect(ping.lng).toBe(106.68);
      const withLocation = unwrap((await get(path, f.tech).expect(200)).body);
      expect(withLocation.technicianLocation).toMatchObject({ lat: 10.75, lng: 106.68 });
      expect(withLocation.destination).toMatchObject({ lat: 10.77, lng: 106.69 });
      const far = unwrap((await post(path + '/check-in', f.tech, { lat: 20, lng: 105, accuracyMeters: 5 }).expect(200)).body);
      expect(far.result).not.toBe('valid');
      denied(await evidence(order.id, f.tech, 'before'));
      await post(path + '/check-in', f.tech, { lat: 10.77, lng: 106.69, accuracyMeters: 5 }).expect(200);
      denied(await post(path + '/evidence', f.tech, { type: 'before', mediaUrl: 'https://example.test/fake.jpg' }));
      await evidence(order.id, f.tech, 'before').expect(201);
      await post(path + '/start-repair', f.tech).expect(200);
      denied(await patch(path + '/location', f.tech, { lat: 10.77, lng: 106.69 }));
      denied(await post(path + '/request-completion', f.tech));
      await evidence(order.id, f.tech, 'after').expect(201);
      await post(path + '/request-completion', f.tech).expect(200);
      denied(await evidence(order.id, f.tech, 'after'));
      denied(await post(path + '/confirm-completion', f.outsider));
      await post(path + '/confirm-completion', f.owner).expect(200);
      expect(unwrap((await get(path, f.owner).expect(200)).body).status).toBe('under_repair');
      denied(await post(path + '/complete', f.tech));
      await post(path + '/cash-settlement/declare', f.tech, { declaredAmount: 400000 }).expect(200);
      const paid = await Promise.all([1, 2].map(() => post(path + '/cash-settlement/confirm', f.owner, { agreed: true, confirmedAmount: 400000 })));

      for (const response of paid) expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(unwrap((await get(path, f.owner).expect(200)).body).status).toBe('completed');
      expect(await context().db.getRepository('Invoice').count({ where: { serviceOrderId: order.id } })).toBe(1);
      expect(await context().db.getRepository('CommissionDue').count({ where: { serviceOrderId: order.id } })).toBe(1);
      denied(await post(path + '/start-repair', f.tech));
      await post(path + '/reviews', f.owner, { rating: 5, comment: 'Complete' }).expect(201);
      denied(await post(path + '/reviews', f.owner, { rating: 5 }));
      const newBooking = await f.create();
      denied(await post(`/bookings/${newBooking.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id, f.spare.user.id] }));
      await context().db.getRepository('Service').update(f.service.id, { fixedPrice: 250000 });
      // Booking again only from a finished or cancelled booking (PO 08/10/2026).
      denied(await post(`/bookings/${newBooking.id}/rebook`, f.owner, { preferredStartAt: f.body.preferredStartAt, preferredEndAt: f.body.preferredEndAt }));
      const rebooked = unwrap((await post(`/bookings/${order.bookingId}/rebook`, f.owner, { preferredStartAt: f.body.preferredStartAt, preferredEndAt: f.body.preferredEndAt }).expect(201)).body);
      expect(Number(rebooked.fixedUnitPriceSnapshot)).toBe(250000);
      expect(rebooked.previousTechnicianId).toBe(f.tech.user.id);
    });

    it('hands an order to another technician after the one on site reported it, costing them no points (PO 08/10/2026)', async () => {
      const f = await fixture(), db = context().db, { order } = await accept(f), path = `/service-orders/${order.id}`;
      const manager = await context().register();
      await db.query('UPDATE users SET role = $1 WHERE id = $2', ['service_manager', manager.user.id]);
      const body = { technicianId: f.spare.user.id, reason: 'Việc ngoài kỹ năng của thợ trước' };
      await post(path + '/en-route', f.tech).expect(200);
      await post(path + '/check-in', f.tech, { lat: 10.77, lng: 106.69, accuracyMeters: 5 }).expect(200);
      await evidence(order.id, f.tech, 'before').expect(201);
      // Not without a report from the technician on site.
      denied(await post(path + '/replace-technician', manager, body));
      await post('/support/cases', f.tech, { caseType: 'technician_replacement', reason: 'Ngoài kỹ năng', serviceOrderId: order.id }).expect(201);
      denied(await post(path + '/replace-technician', f.owner, body));
      denied(await post(path + '/replace-technician', manager, { ...body, technicianId: f.tech.user.id }));
      const replaced = unwrap((await post(path + '/replace-technician', manager, body).expect(200)).body);
      expect(replaced).toMatchObject({ technicianId: f.spare.user.id, previousTechnicianId: f.tech.user.id });
      const [row] = await db.query('SELECT status FROM service_orders WHERE id = $1', [order.id]);
      expect(row.status).toBe('accepted');
      const [kase] = await db.query("SELECT status, resolution_code FROM support_cases WHERE service_order_id = $1 AND case_type = 'technician_replacement'", [order.id]);
      expect(kase).toMatchObject({ status: 'resolved', resolution_code: 'worker_reassigned' });
      const [{ reputation_points: points }] = await db.query('SELECT reputation_points FROM users WHERE id = $1', [f.tech.user.id]);
      expect(Number(points)).toBe(100);
      const told = await db.query("SELECT user_id FROM notifications WHERE type = 'TECHNICIAN_REPLACED' AND reference_id = $1", [order.id]);
      expect(told.map((n: any) => n.user_id).sort()).toEqual([f.owner.user.id, f.tech.user.id, f.spare.user.id].sort());
      // The first technician is out; the new one sets out and checks in themselves.
      denied(await post(path + '/en-route', f.tech));
      await post(path + '/en-route', f.spare).expect(200);
      denied(await evidence(order.id, f.spare, 'before'));
      denied(await post(path + '/replace-technician', manager, body));
      // Not arrived yet themselves, the new technician may still withdraw before arrival.
      await post(path + '/cancel', f.spare, { reason: 'Kẹt xe không tới kịp' }).expect(200);
    });

    it('opens setting out only one hour before the appointment', async () => {
      await setDepartEarlyMinutes(60);
      try {
        const f = await fixture(), { order } = await accept(f);
        const response = await post(`/service-orders/${order.id}/en-route`, f.tech);
        expect(response.status, JSON.stringify(response.body)).toBe(409);
        const detail = unwrap((await get(`/service-orders/${order.id}`, f.tech).expect(200)).body);
        expect(new Date(detail.departAvailableAt).getTime()).toBe(new Date(f.body.preferredStartAt).getTime() - 3600000);
      } finally {
        await setDepartEarlyMinutes(100000);
      }
    });

    it('inspection approval and additional decisions are owner-only and idempotent', async () => {
      const f = await fixture('inspection_required'), { order } = await accept(f), path = `/service-orders/${order.id}`;
      const items = [{ type: 'labor', description: 'Diagnosis and repair', quantity: 1, unitPrice: 100000, warrantyDays: 30 }];
      denied(await post(path + '/quotations', f.tech, { items }));
      await arrived(order.id, f.tech);
      denied(await post(path + '/start-repair', f.tech));
      const quote = unwrap((await post(path + '/quotations', f.tech, { items }).expect(201)).body);
      denied(await post(`/quotations/${quote.id}/decision`, f.outsider, { action: 'APPROVE' }));
      await post(`/quotations/${quote.id}/decision`, f.owner, { action: 'APPROVE' }).expect(200);
      await post(path + '/start-repair', f.tech).expect(200);
      const extra = unwrap((await post(path + '/additional-costs', f.tech, { reason: 'Extra work', items }).expect(201)).body);
      denied(await post(`/additional-costs/${extra.id}/decision`, f.spare, { action: 'APPROVE' }));
      await Promise.all([1, 2].map(() => post(`/additional-costs/${extra.id}/decision`, f.owner, { action: 'APPROVE' }).expect(200)));
      const stored = await context().db.getRepository('ServiceOrder').findOneByOrFail({ id: order.id });
      expect(Number(stored.grandTotal)).toBe(200000);
    });

    it.each([false, true])('keeps technician part warranty opt-in and outside labor commission: selected=%s', async selected => {
      const f = await fixture('inspection_required'), { order } = await accept(f), path = `/service-orders/${order.id}`;
      await arrived(order.id, f.tech);
      const items = [
        { type: 'labor', description: 'Repair labor', quantity: 1, unitPrice: 100000, warrantyDays: 30 },
        { type: 'parts_equipment', description: 'Technician part', quantity: 1, unitPrice: 200000, partSource: 'technician', partWarrantyOption: 'paid_warranty', warrantyFee: 50000, warrantyTermDays: 90 },
      ];
      const quote = unwrap((await post(path + '/quotations', f.tech, { items }).expect(201)).body);
      const part = quote.items.find((item: any) => item.partSource === 'technician');
      await post(`/quotations/${quote.id}/decision`, f.owner, { action: 'APPROVE', paidWarrantyItemIds: selected ? [part.id] : [] }).expect(200);
      await post(path + '/start-repair', f.tech).expect(200);
      const expired = unwrap((await post(path + '/additional-costs', f.tech, { reason: 'Optional work', items: [items[0]] }).expect(201)).body);
      await context().db.getRepository('AdditionalCostRequest').update(expired.id, { expiresAt: new Date(Date.now() - 1) });
      const costs = unwrap((await get(path + '/additional-costs', f.owner).expect(200)).body);
      expect(costs[0].status).toBe('expired');
      denied(await post(`/additional-costs/${expired.id}/decision`, f.owner, { action: 'APPROVE' }));
      await evidence(order.id, f.tech, 'after').expect(201);
      await post(path + '/request-completion', f.tech).expect(200);
      const invoice = unwrap((await get(path + '/invoice', f.owner).expect(200)).body);
      expect(Number(invoice.grandTotal)).toBe(selected ? 350000 : 300000);
      expect(Number(invoice.commissionAmount)).toBe(10000);
      expect(Number(invoice.technicianPartWarrantyFeeTotal)).toBe(selected ? 50000 : 0);
      await post(path + '/cash-settlement/declare', f.tech, { declaredAmount: Number(invoice.grandTotal) }).expect(200);
      const cashResponse = await post(path + '/cash-settlement/confirm', f.owner, { agreed: true, confirmedAmount: selected ? Number(invoice.grandTotal) : 1 });
      expect(cashResponse.status, JSON.stringify(cashResponse.body)).toBe(selected ? 200 : 409);
      const cash = unwrap((await get(path + '/cash-settlement', f.owner).expect(200)).body);
      expect(cash.status).toBe(selected ? 'confirmed' : 'disputed');
      expect(unwrap((await get(path, f.owner).expect(200)).body).status).toBe('under_repair');
      if (selected) {
        await post(path + '/confirm-completion', f.owner).expect(200);
        const warranties = unwrap((await get(path + '/warranties', f.owner).expect(200)).body);
        expect(warranties).toHaveLength(2);
      } else {
        expect(await context().db.getRepository('CommissionDue').count({ where: { serviceOrderId: order.id } })).toBe(0);
      }
    });
  });
}
