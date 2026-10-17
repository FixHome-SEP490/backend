import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NO_DEPARTURE_CANCEL_REASON } from '../src/modules/service-orders/no-departure';

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
      // Check-in is the GPS fix plus the technician's face (PO 11/10/2026).
      await evidence(orderId, actor, 'checkin_face').expect(201);
      await evidence(orderId, actor, 'before').expect(201);
    }

    it("tells the AI a signed-in customer's own earlier repairs, and nobody else's", async () => {
      const { AiDiagnosisService } = runtimeRequire('./dist/modules/ai-diagnosis/ai-diagnosis.service.js');
      const { of } = runtimeRequire('rxjs');
      const http = (context().app.get(AiDiagnosisService) as any).httpService;
      const sent: Array<Record<string, any>> = [];
      const spy = vi.spyOn(http, 'post').mockImplementation(((_url: string, body: Record<string, any>) => {
        sent.push(body);
        return of({ data: { sessionId: `ai-${randomUUID()}`, status: 'ok', answerVi: 'Dạ.', recommendedServices: [] } });
      }) as any);
      try {
        const f = await fixture();
        const { booking } = await accept(f);
        await f.create(); // still waiting for a technician: not a repair yet
        const vnDay = new Date(new Date(booking.preferredStartAt).getTime() + 7 * 3600000).toISOString().slice(0, 10);
        await post('/ai/chat/ask', f.owner, { question: 'máy lạnh không mát' }).expect(200);
        expect(sent[0].pastJobs).toEqual([{ serviceVi: 'Repair fixture', date: vnDay }]);
        await post('/ai/diagnoses', f.owner, { description: 'máy lạnh không mát' }).expect(200);
        expect(sent[1].pastJobs).toEqual([{ serviceVi: 'Repair fixture', date: vnDay }]);
        expect(JSON.stringify(sent[0])).not.toContain('1 Test Street');
        await post('/ai/chat/ask', f.outsider, { question: 'máy lạnh không mát' }).expect(200);
        expect(sent[2]).not.toHaveProperty('pastJobs');
        await post('/ai/chat/ask', f.tech, { question: 'máy lạnh không mát' }).expect(200);
        expect(sent[3]).not.toHaveProperty('pastJobs');
      } finally {
        spy.mockRestore();
      }
    });

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

    it('reads a technician profile with each relation in its own query, complete and without duplicates (PO 14/10/2026)', async () => {
      const f = await fixture();
      const profile = await context().db.getRepository('TechnicianProfile').findOneByOrFail({ userId: f.tech.user.id });
      const category = await save('ServiceCategory', { name: 'Join fixture', code: randomUUID() });
      for (let i = 0; i < 2; i++) {
        const extra = await save('Service', { categoryId: category.id, name: `Join ${i}`, code: randomUUID(), pricingMode: 'fixed_price', fixedPrice: 100000, scopeDescription: 'x', unit: 'job' });
        await save('TechnicianSkill', { technicianId: profile.id, serviceId: extra.id, listedLaborPrice: 100000, verificationStatus: 'verified' });
      }
      for (let i = 0; i < 4; i++) await save('TechnicianServiceArea', { technicianId: profile.id, provinceCode: 'P1', districtCode: `D${i}` });
      for (let i = 0; i < 2; i++) await save('TechnicianTimeOff', { technicianId: profile.id, startAt: new Date(Date.now() + (i + 10) * 86400000), endAt: new Date(Date.now() + (i + 10.5) * 86400000), reason: `off ${i}` });
      // Joined in one statement this would be 3 skills x 4 areas x 7 schedule rows x 2 days off = 168 rows.
      const read = unwrap((await get('/technicians/me/profile', f.tech).expect(200)).body);
      expect(read.skills).toHaveLength(3);
      expect(read.skills.every((s: any) => s.service?.id)).toBe(true);
      expect(read.serviceAreas.map((a: any) => a.districtCode).sort()).toEqual(['D0', 'D1', 'D2', 'D3']);
      expect(read.schedules).toHaveLength(7);
      expect(read.timeOffs).toHaveLength(2);
    });

    it('lists conversations with only the counterpart fields the thread list shows (PO 14/10/2026)', async () => {
      const f = await fixture();
      const b = await f.create();
      await context().db.getRepository('User').update(f.tech.user.id, { fullName: 'Thợ Trò Chuyện' });
      await context().db.getRepository('User').update(f.owner.user.id, { fullName: 'Khách Trò Chuyện' });
      const older = await save('Conversation', { bookingId: b.id, customerId: f.owner.user.id, technicianId: f.tech.user.id, serviceNameSnapshot: 'Repair fixture', lastMessageAt: new Date(Date.now() - 60000), lastMessagePreview: 'cũ' });
      const newer = await save('Conversation', { bookingId: b.id, customerId: f.owner.user.id, technicianId: f.spare.user.id, serviceNameSnapshot: 'Repair fixture', lastMessageAt: new Date(), lastMessagePreview: 'mới' });
      const mine = unwrap((await get('/conversations', f.owner).expect(200)).body);
      expect(mine.map((c: any) => c.id)).toEqual([newer.id, older.id]);
      expect(mine[1]).toMatchObject({ bookingId: b.id, serviceName: 'Repair fixture', lastMessagePreview: 'cũ', status: 'active', canSend: true });
      expect(mine[1].counterpart).toEqual({ id: f.tech.user.id, fullName: 'Thợ Trò Chuyện', avatarUrl: null, role: 'technician' });
      expect(JSON.stringify(mine)).not.toMatch(/email|phone|password/i);
      const theirs = unwrap((await get('/conversations', f.tech).expect(200)).body);
      expect(theirs).toHaveLength(1);
      expect(theirs[0].counterpart).toMatchObject({ id: f.owner.user.id, fullName: 'Khách Trò Chuyện' });
    });

    it('resets reputation every period on the real database, skipping recent and locked accounts (PO 14/10/2026)', async () => {
      const { ReputationService } = runtimeRequire('./dist/modules/reputation/reputation.service.js');
      const service = context().app.get(ReputationService);
      const [due, recent, locked] = [await context().register(), await context().register(), await context().register()];
      const db = context().db;
      await db.query(`UPDATE users SET reputation_points = 60, reputation_period_start = now() - interval '3 months' WHERE id = $1`, [due.user.id]);
      await db.query(`UPDATE users SET reputation_points = 70, reputation_period_start = now() - interval '10 days' WHERE id = $1`, [recent.user.id]);
      await db.query(`UPDATE users SET reputation_points = 50, reputation_period_start = now() - interval '3 months', status = 'locked' WHERE id = $1`, [locked.user.id]);
      // Before 14/10/2026 this threw "invalid input syntax for type integer: NaN" on every run.
      await expect(service.resetSweep()).resolves.toBeGreaterThanOrEqual(1);
      const points = async (id: string) => Number((await db.query('SELECT reputation_points FROM users WHERE id = $1', [id]))[0].reputation_points);
      expect(await points(due.user.id)).toBe(100);
      expect(await points(recent.user.id)).toBe(70);
      expect(await points(locked.user.id)).toBe(50);
      const [event] = await db.query(`SELECT kind, delta, points_after FROM reputation_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [due.user.id]);
      expect(event).toMatchObject({ kind: 'reset', delta: 40, points_after: 100 });
      // A second run finds nothing due and writes nothing.
      await expect(service.resetSweep()).resolves.toBe(0);
    });

    it('writes one clean address line and reads old repeated lines back tidied (PO 12/10/2026)', async () => {
      const f = await fixture();
      // What the map search saved: postcode, country and the ward again inside line1.
      await context().db.getRepository('Address').update(f.address.id, { line1: 'Đường Vành Đai KTX Khu B, 700000 Phường Đông Hòa, Việt Nam', ward: 'Phường Đông Hòa' });
      const b = await f.create();
      expect(b.addressTextSnapshot).toBe('Đường Vành Đai KTX Khu B, Phường Đông Hòa, D1, P1');
      // A snapshot saved before the fix is not rewritten, only read back tidied.
      const old = 'Đường Vành Đai KTX Khu B, 700000 Phường Đông Hòa, Việt Nam, Phường Đông Hòa, Phường Đông Hòa, TP. Hồ Chí Minh';
      await context().db.query('UPDATE bookings SET address_text_snapshot = $1 WHERE id = $2', [old, b.id]);
      const read = unwrap((await get(`/bookings/${b.id}`, f.owner).expect(200)).body);
      expect(read.addressTextSnapshot).toBe('Đường Vành Đai KTX Khu B, Phường Đông Hòa, TP. Hồ Chí Minh');
      const [stored] = await context().db.query('SELECT address_text_snapshot FROM bookings WHERE id = $1', [b.id]);
      expect(stored.address_text_snapshot).toBe(old);
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
      await evidence(order.id, f.tech, 'checkin_face').expect(201);
      await evidence(order.id, f.tech, 'before').expect(201);
      await evidence(order.id, f.tech, 'after').expect(201);
      // No customer acceptance (PO 09/10/2026): the technician's completion with the after photo is enough.
      await post(path + '/request-completion', f.tech).expect(200);
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
      // A refund goes into the wallet only for a faulty part or a warranty failure, FixHome bearing it (PO 09/10/2026).
      const manager = await context().register();
      await db.query('UPDATE users SET role = $1 WHERE id = $2', ['service_manager', manager.user.id]);
      const quality = unwrap((await post('/support/cases', f.owner, { caseType: 'quality', reason: 'Máy vẫn kêu sau khi sửa', serviceOrderId: order.id }).expect(201)).body).id;
      denied(await post(`/support/cases/${quality}/resolve`, manager, { finalStatus: 'resolved', resolutionCode: 'refund_to_wallet', reason: 'Hoàn tiền vì sửa chưa đạt', amount: 50000 }));
      const opened = await post('/support/cases', f.owner, { caseType: 'parts_dispute', reason: 'Linh kiện thay vào bị hỏng', serviceOrderId: order.id });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const caseId = unwrap(opened.body).id;
      denied(await post(`/support/cases/${caseId}/resolve`, manager, { finalStatus: 'resolved', resolutionCode: 'refund_to_wallet', reason: 'Hoàn một phần vì sửa chưa đạt', amount: total + 1 }));
      denied(await post(`/support/cases/${caseId}/resolve`, manager, { finalStatus: 'resolved', resolutionCode: 'refund_to_wallet', reason: 'Hoàn một phần vì sửa chưa đạt' }));
      await post(`/support/cases/${caseId}/resolve`, manager, { finalStatus: 'resolved', resolutionCode: 'refund_to_wallet', reason: 'Hoàn một phần vì sửa chưa đạt', amount: 150000 }).expect(200);
      const wallet = unwrap((await get('/customer/wallet', f.owner).expect(200)).body);
      expect(wallet.balance).toBe(750000);
      expect(wallet.transactions.map((t: any) => t.type)).toEqual(['refund', 'invoice_payment']);
      const [refundCase] = await db.query('SELECT liable_party FROM support_cases WHERE id = $1', [caseId]);
      expect(refundCase.liable_party).toBe('platform');
      await post(`/support/cases/${quality}/resolve`, manager, { finalStatus: 'resolved', resolutionCode: 'no_action', reason: 'Không hoàn tiền cho khiếu nại chất lượng' }).expect(200);
      const second = unwrap((await post('/support/cases', f.owner, { caseType: 'parts_dispute', reason: 'Linh kiện vẫn hỏng', serviceOrderId: order.id }).expect(201)).body).id;
      denied(await post(`/support/cases/${second}/resolve`, manager, { finalStatus: 'resolved', resolutionCode: 'refund_to_wallet', reason: 'Hoàn thêm phần còn lại của đơn', amount: total - 150000 + 1 }));
      denied(await get('/customer/wallet', f.tech));
      // The admin sees every customer wallet and corrects one with a reason, audited (PO 09/10/2026).
      // The outsider of the fixture becomes the admin: one more sign-up would hit the register rate limit.
      const admin = f.outsider;
      await db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', admin.user.id]);
      const owner = `/admin/customer-wallets/${f.owner.user.id}`;
      const [{ email: ownerEmail }] = await db.query('SELECT email FROM users WHERE id = $1', [f.owner.user.id]);
      const listed = await get(`/admin/customer-wallets?withBalance=true&search=${encodeURIComponent(ownerEmail)}`, admin).expect(200);
      expect(unwrap(listed.body)).toEqual([expect.objectContaining({ userId: f.owner.user.id, balance: 750000 })]);
      expect(listed.body.meta.totalBalance).toBe(750000);
      const phone = `09${String(Date.now()).slice(-8)}`;
      await db.query('UPDATE users SET phone_number = $1 WHERE id = $2', [phone, f.owner.user.id]);
      const byPhone = unwrap((await get(`/admin/customer-wallets?search=${encodeURIComponent('+84 ' + phone.slice(1))}`, admin).expect(200)).body);
      expect(byPhone.map((r: any) => r.userId)).toContain(f.owner.user.id);
      expect(unwrap((await get(owner, admin).expect(200)).body)).toMatchObject({ customer: { id: f.owner.user.id }, balance: 750000 });
      for (const user of [manager, f.owner, f.tech]) {
        denied(await get('/admin/customer-wallets', user));
        denied(await post(owner + '/adjustments', user, { type: 'CREDIT', amount: 1000, reason: 'Thử điều chỉnh không có quyền' }));
      }
      denied(await post(owner + '/adjustments', admin, { type: 'CREDIT', amount: 1000, reason: 'ngắn' }));
      denied(await post(owner + '/adjustments', admin, { type: 'CREDIT', amount: 0, reason: 'Số tiền phải lớn hơn không' }));
      denied(await post(owner + '/adjustments', admin, { type: 'DEBIT', amount: 750001, reason: 'Trừ nhiều hơn số dư đang có' }));
      denied(await post(`/admin/customer-wallets/${f.tech.user.id}/adjustments`, admin, { type: 'CREDIT', amount: 1000, reason: 'Ví khách không áp cho thợ' }));
      const credited = unwrap((await post(owner + '/adjustments', admin, { type: 'CREDIT', amount: 20000, reason: 'Bù khoản hoàn ghi thiếu cho đơn' }).expect(201)).body);
      expect(credited.balanceAfter).toBe(770000);
      await post(owner + '/adjustments', admin, { type: 'DEBIT', amount: 70000, reason: 'Thu lại khoản cộng nhầm hôm trước' }).expect(201);
      const corrected = unwrap((await get('/customer/wallet', f.owner).expect(200)).body);
      expect(corrected.balance).toBe(700000);
      expect(corrected.transactions.slice(0, 2).map((t: any) => t.type)).toEqual(['adjustment_debit', 'adjustment_credit']);
      const audits = await db.query("SELECT after FROM audit_logs WHERE action = 'CUSTOMER_WALLET_ADJUSTMENT' AND actor_user_id = $1", [admin.user.id]);
      expect(audits).toHaveLength(2);
      const notes = await db.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'WALLET_ADJUSTED'", [f.owner.user.id]);
      expect(notes.length).toBeGreaterThanOrEqual(1);
      // The admin lists the payments with who paid and the order behind them (PO 09/10/2026).
      const [{ code: orderCode }] = await db.query('SELECT code FROM service_orders WHERE id = $1', [order.id]);
      const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
      const payments = await get(`/admin/payments?search=${encodeURIComponent(orderCode)}&status=verified&from=${today}&to=${today}`, admin).expect(200);
      expect(unwrap(payments.body)).toEqual([expect.objectContaining({
        purpose: 'invoice', provider: 'wallet', status: 'verified', amount: total, orderCode, payerId: f.owner.user.id, payerRole: 'customer',
      })]);
      expect(payments.body.meta.summary).toMatchObject({ verifiedAmount: total, verified: 1 });
      expect(unwrap((await get(`/admin/payments?search=${encodeURIComponent(orderCode)}&status=failed`, admin).expect(200)).body)).toEqual([]);
      expect(unwrap((await get(`/admin/payments?search=${encodeURIComponent(orderCode)}&provider=vnpay`, admin).expect(200)).body)).toEqual([]);
      const yesterday = new Date(Date.now() + 7 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
      expect(unwrap((await get(`/admin/payments?search=${encodeURIComponent(orderCode)}&to=${yesterday}`, admin).expect(200)).body)).toEqual([]);
      for (const user of [manager, f.owner, f.tech]) denied(await get('/admin/payments', user));
      // Earnings of a period, Vietnam days (PO 12/10/2026): today holds this order, yesterday does not.
      const todayEarnings = unwrap((await get(`/technicians/me/earnings?from=${today}&to=${today}&page=1&pageSize=5`, f.tech).expect(200)).body);
      expect(todayEarnings).toMatchObject({ from: today, to: today, totalCompletedOrders: 1, paidOrders: 1, totalOrderValue: total, page: 1, pageSize: 5, total: 1 });
      expect(todayEarnings.payouts[0]).toMatchObject({ orderId: order.id, paid: true, orderValue: total });
      expect(unwrap((await get(`/technicians/me/earnings?from=${yesterday}&to=${yesterday}`, f.tech).expect(200)).body).totalCompletedOrders).toBe(0);
      denied(await get(`/technicians/me/earnings?from=${today}&to=${yesterday}`, f.tech));
      denied(await get('/technicians/me/earnings?from=12-10-2026', f.tech));
      const claims = await get('/warranty-claims/mine?page=1&pageSize=5', f.tech).expect(200);
      expect(claims.body.meta).toMatchObject({ page: 1, pageSize: 5, total: 0 });
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
      denied(await evidence(order.id, f.tech, 'checkin_face'));
      denied(await evidence(order.id, f.tech, 'before'));
      // PO 11/10/2026: 5 km of distance and of reported GPS error pass, beyond that they do not.
      expect(unwrap((await post(path + '/check-in', f.tech, { lat: 10.824, lng: 106.69, accuracyMeters: 30 }).expect(200)).body).result).toBe('out_of_geofence');
      expect(unwrap((await post(path + '/check-in', f.tech, { lat: 10.77, lng: 106.69, accuracyMeters: 6000 }).expect(200)).body).result).toBe('low_accuracy');
      expect(unwrap((await post(path + '/check-in', f.tech, { lat: 10.797, lng: 106.69, accuracyMeters: 4000 }).expect(200)).body).result).toBe('valid');
      denied(await post(path + '/evidence', f.tech, { type: 'before', mediaUrl: 'https://example.test/fake.jpg' }));
      // The product photo waits for the face taken at check-in.
      const noFace = await evidence(order.id, f.tech, 'before');
      expect(noFace.status, JSON.stringify(noFace.body)).toBe(409);
      const face = unwrap((await evidence(order.id, f.tech, 'checkin_face').expect(201)).body);
      expect(face.type).toBe('checkin_face');
      denied(await request(context().app.getHttpServer()).delete(`/api/v1/service-orders/${order.id}/evidence/${face.id}`).set('Authorization', `Bearer ${f.tech.accessToken}`));
      await evidence(order.id, f.tech, 'before').expect(201);
      await post(path + '/start-repair', f.tech).expect(200);
      denied(await patch(path + '/location', f.tech, { lat: 10.77, lng: 106.69 }));
      denied(await post(path + '/request-completion', f.tech));
      await evidence(order.id, f.tech, 'after').expect(201);
      // A photo over 1 MB goes up (10/10/2026: the 1 MB form limit used to answer 413 to every real photo).
      const largePhoto = Buffer.concat([png, Buffer.alloc(2_500_000)]);
      const large = await request(context().app.getHttpServer()).post(`/api/v1${path}/evidence`).set('Authorization', `Bearer ${f.tech.accessToken}`).field('type', 'after').attach('file', largePhoto, { filename: 'after-large.png', contentType: 'image/png' });
      expect(large.status, JSON.stringify(large.body)).toBe(201);
      await post(path + '/request-completion', f.tech).expect(200);
      denied(await evidence(order.id, f.tech, 'after'));
      // The customer no longer accepts the work (PO 09/10/2026); only the payment is left.
      denied(await post(path + '/confirm-completion', f.outsider));
      expect(unwrap((await get(path, f.owner).expect(200)).body).status).toBe('under_repair');
      expect(await context().db.getRepository('CustomerServiceConfirmation').count({ where: { serviceOrderId: order.id } })).toBe(0);
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
      // The admin reads the reviews with who rated whom on which order (PO 09/10/2026).
      denied(await get('/admin/reviews', f.owner));
      denied(await get('/admin/reviews', f.tech));
      await context().db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', f.outsider.user.id]);
      const [{ code: reviewedCode }] = await context().db.query('SELECT code FROM service_orders WHERE id = $1', [order.id]);
      const reviews = await get(`/admin/reviews?search=${encodeURIComponent(reviewedCode)}`, f.outsider).expect(200);
      expect(unwrap(reviews.body)).toEqual([expect.objectContaining({
        rating: 5, comment: 'Complete', orderCode: reviewedCode, customerId: f.owner.user.id, technicianId: f.tech.user.id,
      })]);
      expect(reviews.body.meta.summary).toMatchObject({ average: 5, stars: { 5: 1, 1: 0 } });
      expect(unwrap((await get(`/admin/reviews?search=${encodeURIComponent(reviewedCode)}&maxRating=2`, f.outsider).expect(200)).body)).toEqual([]);
      expect(unwrap((await get(`/admin/reviews?search=${encodeURIComponent(reviewedCode)}&rating=9`, f.outsider).expect(200)).body)).toHaveLength(1);
      await context().db.query('UPDATE users SET role = $1 WHERE id = $2', ['customer', f.outsider.user.id]);
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
      await evidence(order.id, f.tech, 'checkin_face').expect(201);
      await evidence(order.id, f.tech, 'before').expect(201);
      // Not without a report from the technician on site.
      denied(await post(path + '/replace-technician', manager, body));
      // The manager's overview counts the reports still waiting (PO 09/10/2026).
      const ops = async () => unwrap((await get('/dashboard/operations', manager).expect(200)).body);
      const waiting = (await ops()).openReplacementCases;
      await post('/support/cases', f.tech, { caseType: 'technician_replacement', reason: 'Ngoài kỹ năng', serviceOrderId: order.id }).expect(201);
      expect((await ops()).openReplacementCases).toBe(waiting + 1);
      denied(await post(path + '/replace-technician', f.owner, body));
      denied(await post(path + '/replace-technician', manager, { ...body, technicianId: f.tech.user.id }));
      const replaced = unwrap((await post(path + '/replace-technician', manager, body).expect(200)).body);
      expect(replaced).toMatchObject({ technicianId: f.spare.user.id, previousTechnicianId: f.tech.user.id });
      const [row] = await db.query('SELECT status FROM service_orders WHERE id = $1', [order.id]);
      expect(row.status).toBe('accepted');
      const [kase] = await db.query("SELECT status, resolution_code FROM support_cases WHERE service_order_id = $1 AND case_type = 'technician_replacement'", [order.id]);
      expect(kase).toMatchObject({ status: 'resolved', resolution_code: 'worker_reassigned' });
      expect((await ops()).openReplacementCases).toBe(waiting);
      // Orders the system cancelled because the technician never set out, over the last 7 days.
      const autoCancelled = (await ops()).noDepartureCancellations7d;
      const insertCancel = (at: string) => db.query(
        "INSERT INTO cancellations (service_order_id, actor, actor_user_id, reason, state_at_cancel, created_at) VALUES ($1, 'technician', $2, $3, 'accepted', $4)",
        [order.id, f.tech.user.id, NO_DEPARTURE_CANCEL_REASON, at],
      );
      await insertCancel(new Date().toISOString());
      await insertCancel(new Date(Date.now() - 8 * 86_400_000).toISOString());
      expect((await ops()).noDepartureCancellations7d).toBe(autoCancelled + 1);
      denied(await get('/dashboard/operations', f.tech));
      await db.query('DELETE FROM cancellations WHERE service_order_id = $1 AND reason = $2', [order.id, NO_DEPARTURE_CANCEL_REASON]);
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

    it('lets an admin find a technician by name, email, phone, CCCD or id, never by address, and read everything about them (PO 08/10/2026)', async () => {
      const f = await fixture(), db = context().db;
      const admin = await context().register();
      await db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', admin.user.id]);
      const tag = randomUUID().slice(0, 8);
      await db.query('UPDATE users SET full_name = $2, phone_number = $3, citizen_id_number = $4 WHERE id = $1', [f.tech.user.id, `Thợ Tra Cứu ${tag}`, `09${tag.replace(/\D/g, '').padEnd(8, '7').slice(0, 8)}`, `0790${tag.replace(/\D/g, '').padEnd(8, '1').slice(0, 8)}`]);
      const [u] = await db.query('SELECT email, phone_number AS phone, citizen_id_number AS cccd FROM users WHERE id = $1', [f.tech.user.id]);
      const found = async (search: string) => unwrap((await get(`/admin/technicians?search=${encodeURIComponent(search)}&pageSize=100`, admin).expect(200)).body).map((r: any) => r.id);
      expect(await found(`Tra Cứu ${tag}`)).toContain(f.tech.user.id);
      expect(await found(`tho tra cuu ${tag}`)).toContain(f.tech.user.id);
      expect(await found(u.email)).toContain(f.tech.user.id);
      expect(await found(u.phone)).toContain(f.tech.user.id);
      expect(await found('+84' + u.phone.slice(1))).toContain(f.tech.user.id);
      expect(await found(u.cccd)).toContain(f.tech.user.id);
      expect(await found(f.tech.user.id.slice(0, 8))).toContain(f.tech.user.id);
      expect(await found('Tech shop')).not.toContain(f.tech.user.id);
      denied(await get('/admin/technicians?search=x', f.owner));
      denied(await get('/admin/technicians?search=x', f.tech));
      const detail = unwrap((await get(`/admin/technicians/${f.tech.user.id}`, admin).expect(200)).body);
      expect(detail.user).toMatchObject({ id: f.tech.user.id, citizenIdNumber: u.cccd, reputationPoints: 100 });
      expect(detail.profile.verificationStatus).toBe('verified');
      expect(detail.skills).toEqual([expect.objectContaining({ serviceName: 'Repair fixture', listedLaborPrice: 100000 })]);
      expect(detail.schedule).toHaveLength(7);
      denied(await get(`/admin/technicians/${f.owner.user.id}`, admin));
    });

    it('tells a technician whether they receive jobs now: schedule switches, manual pauses (PO 08/10/2026)', async () => {
      const fresh = await context().provisionTechnician();
      expect(unwrap((await get('/technicians/me/availability', fresh).expect(200)).body)).toMatchObject({ state: 'no_schedule', receiving: false });
      const f = await fixture();
      const scheduled = unwrap((await get('/technicians/me/availability', f.tech).expect(200)).body);
      expect(['receiving', 'off_hours']).toContain(scheduled.state);
      expect(scheduled.nextStartAt).toBeTruthy();
      await patch('/technicians/me/profile', f.tech, { isAvailable: false }).expect(200);
      expect(unwrap((await get('/technicians/me/availability', f.tech).expect(200)).body)).toMatchObject({ state: 'paused', receiving: false });
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

    it('snapshots the technician labor warranty on accept and uses it as the quote default (PO 10/10/2026)', async () => {
      const f = await fixture('inspection_required'), db = context().db;
      const put = (path: string, session: Session, body: object) => request(context().app.getHttpServer()).put(`/api/v1${path}`).set('Authorization', `Bearer ${session.accessToken}`).send(body);
      denied(await put('/technicians/me/warranty-default', f.owner, { days: 90 }));
      for (const days of [-1, 1.5, 3651]) denied(await put('/technicians/me/warranty-default', f.tech, { days }));
      // Above warranty.max_days (365) is refused too.
      denied(await put('/technicians/me/warranty-default', f.tech, { days: 400 }));
      denied(await put(`/technicians/me/services/${f.service.id}`, f.tech, { typicalWarrantyDays: 400 }));
      // Only the default: the service keeps its own 30 days, which wins.
      expect(unwrap((await put('/technicians/me/warranty-default', f.tech, { days: 60 }).expect(200)).body)).toEqual({ defaultLaborWarrantyDays: 60, servicesUpdated: 0 });
      expect(unwrap((await get('/technicians/me/profile', f.tech).expect(200)).body).defaultLaborWarrantyDays).toBe(60);
      expect(unwrap((await get('/technicians/me/services', f.tech).expect(200)).body)[0].typicalWarrantyDays).toBe(30);
      expect(unwrap((await put('/technicians/me/warranty-default', f.tech, { days: 90, applyToAllServices: true }).expect(200)).body)).toEqual({ defaultLaborWarrantyDays: 90, servicesUpdated: 1 });
      const { order } = await accept(f), path = `/service-orders/${order.id}`;
      expect(unwrap((await get(path, f.tech).expect(200)).body).laborWarrantyDays).toBe(90);
      // Changing the default later does not touch an order already accepted.
      await put('/technicians/me/warranty-default', f.tech, { days: 10, applyToAllServices: true }).expect(200);
      await arrived(order.id, f.tech);
      denied(await post(path + '/quotations', f.tech, { items: [{ type: 'labor', description: 'Repair labor', quantity: 1, unitPrice: 100000, warrantyDays: 366 }] }));
      const quote = unwrap((await post(path + '/quotations', f.tech, { items: [{ type: 'labor', description: 'Repair labor', quantity: 1, unitPrice: 100000 }] }).expect(201)).body);
      expect(quote.items[0].warrantyDaysSnapshot).toBe(90);
      await post(`/quotations/${quote.id}/decision`, f.owner, { action: 'APPROVE' }).expect(200);
      await post(path + '/start-repair', f.tech).expect(200);
      await evidence(order.id, f.tech, 'after').expect(201);
      await post(path + '/request-completion', f.tech).expect(200);
      const invoice = unwrap((await get(path + '/invoice', f.owner).expect(200)).body);
      await post(path + '/cash-settlement/declare', f.tech, { declaredAmount: Number(invoice.grandTotal) }).expect(200);
      await post(path + '/cash-settlement/confirm', f.owner, { agreed: true, confirmedAmount: Number(invoice.grandTotal) }).expect(200);
      expect((await db.query('SELECT warranty_days_snapshot AS days FROM warranty_coverages WHERE service_order_id = $1', [order.id])).map((r: any) => r.days)).toEqual([90]);
    });

    it('puts the technician default labor warranty on a fixed-price invoice (PO 10/10/2026)', async () => {
      const f = await fixture(), db = context().db;
      const put = (path: string, session: Session, body: object) => request(context().app.getHttpServer()).put(`/api/v1${path}`).set('Authorization', `Bearer ${session.accessToken}`).send(body);
      // No per-service value: the technician default applies.
      await db.getRepository('TechnicianSkill').update({ serviceId: f.service.id }, { typicalWarrantyDays: null });
      await put('/technicians/me/warranty-default', f.tech, { days: 45 }).expect(200);
      const { order } = await accept(f), path = `/service-orders/${order.id}`;
      expect(unwrap((await get(path, f.tech).expect(200)).body).laborWarrantyDays).toBe(45);
      await arrived(order.id, f.tech);
      await evidence(order.id, f.tech, 'after').expect(201);
      await post(path + '/request-completion', f.tech).expect(200);
      await get(path + '/invoice', f.owner).expect(200);
      const [line] = await db.query("SELECT ii.warranty_days_snapshot AS days FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.service_order_id = $1 AND ii.source_type = 'FIXED_PRICE'", [order.id]);
      expect(line.days).toBe(45);
    });

    it('accepts an invitation for a technician who switched on auto-accept (PO 10/10/2026)', async () => {
      const f = await fixture(), db = context().db;
      expect(unwrap((await get('/technicians/me/profile', f.tech).expect(200)).body).autoAcceptInvitations).toBe(false);
      denied(await patch('/technicians/me/profile', f.tech, { autoAcceptInvitations: 'yes' }));
      await patch('/technicians/me/profile', f.tech, { autoAcceptInvitations: true }).expect(200);
      expect(unwrap((await get('/technicians/me/profile', f.tech).expect(200)).body).autoAcceptInvitations).toBe(true);
      const booking = await f.create();
      const shortlisted = await post(`/bookings/${booking.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id, f.spare.user.id] });
      expect(shortlisted.status, JSON.stringify(shortlisted.body)).toBe(201);
      expect(unwrap(shortlisted.body).map((i: any) => i.status)).toEqual(['accepted', 'cancelled']);
      const [order] = await db.query(`SELECT o.id, o.status, a.technician_id FROM service_orders o JOIN technician_assignments a ON a.service_order_id = o.id AND a.is_active WHERE o.booking_id = $1`, [booking.id]);
      expect(order).toMatchObject({ status: 'accepted', technician_id: f.tech.user.id });
      const [history] = await db.query('SELECT reason FROM order_status_history WHERE service_order_id = $1', [order.id]);
      expect(history.reason).toContain('tự nhận việc');
      const notes = await db.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'INVITATION_AUTO_ACCEPTED' AND reference_id = $2", [f.tech.user.id, order.id]);
      expect(notes).toHaveLength(1);
      expect(unwrap((await get(`/bookings/${booking.id}`, f.owner).expect(200)).body).status).toBe('matched');
    });

    it('searches and filters lists on the server, accents ignored (PO 12/10/2026: every table pages)', async () => {
      const f = await fixture(), db = context().db, { order, booking } = await accept(f);
      await db.query("UPDATE bookings SET service_name_snapshot = 'Sửa điều hòa không mát' WHERE id = $1", [booking.id]);
      const ids = (res: request.Response) => unwrap(res.body).map((o: any) => o.id);
      expect(ids(await get('/service-orders/my?search=dieu%20hoa', f.owner).expect(200))).toEqual([order.id]);
      expect(ids(await get('/service-orders/my?search=DIEU%20HOA&statuses=accepted,en_route', f.tech).expect(200))).toEqual([order.id]);
      expect(ids(await get('/service-orders/my?statuses=completed,cancelled', f.owner).expect(200))).toEqual([]);
      expect(ids(await get('/service-orders/my?search=khong%20co%20don%20nay', f.owner).expect(200))).toEqual([]);
      const [{ code }] = await db.query('SELECT code FROM service_orders WHERE id = $1', [order.id]);
      expect(ids(await get(`/service-orders/my?search=${encodeURIComponent(code.slice(-6).toLowerCase())}`, f.owner).expect(200))).toEqual([order.id]);
      denied(await get('/service-orders/my?statuses=accepted,flying', f.owner));
      // The customer finds the order by the technician's name, without accents.
      await db.query("UPDATE users SET full_name = 'Phạm Đức Toàn' WHERE id = $1", [f.tech.user.id]);
      expect(ids(await get('/service-orders/my?search=duc%20toan', f.owner).expect(200))).toEqual([order.id]);
      expect(unwrap((await get('/bookings/my?search=dieu%20hoa&statuses=matched,matching', f.owner).expect(200)).body).map((b: any) => b.id)).toEqual([booking.id]);
      // Staff board: the appointment two days ahead is not overdue; once it has passed it is.
      const manager = f.outsider;
      await db.query('UPDATE users SET role = $1 WHERE id = $2', ['service_manager', manager.user.id]);
      const staffIds = async (query: string) => unwrap((await get(`/bookings?${query}`, manager).expect(200)).body).map((b: any) => b.id);
      expect(await staffIds('overdue=false&search=dieu%20hoa')).toContain(booking.id);
      expect(await staffIds('overdue=true&search=dieu%20hoa')).not.toContain(booking.id);
      await db.query("UPDATE bookings SET preferred_start_at = now() - interval '1 hour' WHERE id = $1", [booking.id]);
      expect(await staffIds('overdue=true&sort=appointment&search=dieu%20hoa')).toContain(booking.id);
      denied(await get('/bookings?sort=random', manager));
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
      // Confirmed cash after the technician's completion finishes the order, with no customer acceptance (PO 09/10/2026).
      expect(unwrap((await get(path, f.owner).expect(200)).body).status).toBe(selected ? 'completed' : 'under_repair');
      if (selected) {
        const warranties = unwrap((await get(path + '/warranties', f.owner).expect(200)).body);
        expect(warranties).toHaveLength(2);
        // Each coverage names the invoice line it covers, so the customer knows what to claim.
        expect(warranties.map((w: any) => [w.itemType, w.itemDescription, w.warrantyDaysSnapshot]).sort()).toEqual([
          ['labor', 'Repair labor', 30],
          ['parts_equipment', 'Technician part', 90],
        ]);
      } else {
        expect(await context().db.getRepository('CommissionDue').count({ where: { serviceOrderId: order.id } })).toBe(0);
      }
    });

    it('lets a customer withdraw the wallet after an admin-approved CCCD check, paid out at once (PO 14/10/2026)', async () => {
      const { db, app } = context();
      const customer = await context().register();
      const admin = await context().register();
      const manager = await context().register();
      await db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', admin.user.id]);
      await db.query('UPDATE users SET role = $1 WHERE id = $2', ['service_manager', manager.user.id]);
      const put = (path: string, session: Session, body: object) => request(app.getHttpServer()).put(`/api/v1${path}`).set('Authorization', `Bearer ${session.accessToken}`).send(body);
      const expectStatus = (response: request.Response, status: number) => expect(response.status, JSON.stringify(response.body)).toBe(status);
      // payOS is never called: the payout provider is faked on the running app.
      const payoutModule = runtimeRequire('./dist/modules/wallet/payout/payout-provider.js');
      const provider = app.get(payoutModule.PAYOUT_PROVIDER, { strict: false });
      const originalName = provider.name;
      Object.defineProperty(provider, 'name', { value: 'payos', configurable: true, writable: true });
      const createPayout = vi.spyOn(provider, 'createPayout');
      const spies = [
        createPayout,
        vi.spyOn(provider, 'getSourceBalance').mockResolvedValue(100_000_000),
        vi.spyOn(provider, 'estimateCredit').mockImplementation(async (instruction: any) => instruction.amount),
        vi.spyOn(provider, 'findPayoutByReference').mockResolvedValue(null),
      ];
      try {
        const adjust = (amount: number) => post(`/admin/customer-wallets/${customer.user.id}/adjustments`, admin, { type: 'CREDIT', amount, reason: 'Nạp thử cho kịch bản rút tiền' }).expect(201);
        await adjust(150000);

        // No KYC yet: the wallet says so, a bank account and a withdrawal are refused.
        const before = unwrap((await get('/customer/wallet', customer).expect(200)).body);
        expect(before.withdrawal).toMatchObject({ kycStatus: 'none', hasBankAccount: false, minimumAmount: 10000, canWithdraw: false });
        expectStatus(await post('/customer/wallet/withdrawals', customer, { amount: 50000 }), 422);
        expectStatus(await put('/customer/wallet/bank-account', customer, { bankBin: '970436', accountNumber: '0123456789', accountName: 'NGUYEN VAN KHACH' }), 422);
        expect(createPayout).not.toHaveBeenCalled();

        // Submit KYC: card front and back only, details as on the card.
        const cccd = String(Date.now()).slice(-12);
        const kyc = {
          fullName: 'Nguyễn Văn Khách', dateOfBirth: '1990-05-20', gender: 'male', citizenIdNumber: cccd,
          address: '12 Nguyễn Trãi, Phường Bến Thành, TP. Hồ Chí Minh',
          documents: [
            { documentType: 'citizen_id_front', storageObjectPath: `kyc/${customer.user.id}/front.jpg`, fileName: 'mat-truoc.jpg', fileSize: 2048, mimeType: 'image/jpeg' },
            { documentType: 'citizen_id_back', storageObjectPath: `kyc/${customer.user.id}/back.jpg`, fileName: 'mat-sau.jpg', fileSize: 2048, mimeType: 'image/jpeg' },
          ],
        };
        expectStatus(await post('/customer/verification', customer, { ...kyc, fullName: 'Khách 😀' }), 400);
        expectStatus(await post('/customer/verification', customer, { ...kyc, citizenIdNumber: '12345' }), 400);
        expectStatus(await post('/customer/verification', customer, { ...kyc, documents: [kyc.documents[0], { ...kyc.documents[1], mimeType: 'application/pdf', fileName: 'mat-sau.pdf' }] }), 400);
        expectStatus(await post('/customer/verification', customer, { ...kyc, documents: [kyc.documents[0], { ...kyc.documents[1], storageObjectPath: `kyc/${admin.user.id}/back.jpg` }] }), 422);
        expectStatus(await post('/customer/verification', customer, { ...kyc, documents: [kyc.documents[0]] }), 400);
        const submitted = unwrap((await post('/customer/verification', customer, kyc).expect(201)).body);
        expect(submitted).toMatchObject({ status: 'pending', verification: { fullName: 'Nguyễn Văn Khách', citizenIdNumber: cccd, dateOfBirth: '1990-05-20' } });
        const [profile] = await db.query('SELECT full_name, date_of_birth::text AS dob, gender, citizen_id_number, full_address FROM users WHERE id = $1', [customer.user.id]);
        expect(profile).toMatchObject({ full_name: 'Nguyễn Văn Khách', dob: '1990-05-20', gender: 'male', citizen_id_number: cccd, full_address: kyc.address });
        denied(await post('/customer/verification', customer, kyc));
        // Pending: still no withdrawal.
        const pending = await post('/customer/wallet/withdrawals', customer, { amount: 50000 });
        expectStatus(pending, 422);
        expect(JSON.stringify(pending.body)).toContain('chờ duyệt');

        // Only an admin reviews; the customer and a service manager cannot.
        const id = submitted.verification.id;
        for (const user of [manager, customer]) {
          denied(await get('/admin/customer-verifications', user));
          denied(await patch(`/admin/customer-verifications/${id}/approve`, user));
          denied(await patch(`/admin/customer-verifications/${id}/reject`, user, { rejectionReason: 'Không có quyền duyệt' }));
        }
        const found = async (search: string) => unwrap((await get(`/admin/customer-verifications?status=pending&search=${encodeURIComponent(search)}`, admin).expect(200)).body).map((v: any) => v.id);
        expect(await found(cccd.slice(0, 8))).toContain(id);
        expect(await found('nguyen van khach')).toContain(id);
        expect(unwrap((await get(`/admin/customer-verifications/${id}`, admin).expect(200)).body)).toMatchObject({
          customer: { id: customer.user.id }, documents: [{ documentType: 'citizen_id_front' }, { documentType: 'citizen_id_back' }],
        });
        expectStatus(await patch(`/admin/customer-verifications/${id}/reject`, admin, { rejectionReason: 'abc' }), 400);
        expect(unwrap((await patch(`/admin/customer-verifications/${id}/approve`, admin).expect(200)).body)).toMatchObject({ status: 'verified', verifiedFullName: 'Nguyễn Văn Khách' });
        denied(await patch(`/admin/customer-verifications/${id}/approve`, admin));
        const [decision] = await db.query("SELECT actor_user_id FROM audit_logs WHERE action = 'CUSTOMER_KYC_APPROVED' AND resource_id = $1", [id]);
        expect(decision.actor_user_id).toBe(admin.user.id);

        // Approved: the name is locked on the profile, the same value is still accepted.
        expectStatus(await patch('/me', customer, { fullName: 'Tên Khác Hẳn' }), 422);
        await patch('/me', customer, { fullName: 'Nguyễn Văn Khách' }).expect(200);
        const [locked] = await db.query('SELECT full_name FROM users WHERE id = $1', [customer.user.id]);
        expect(locked.full_name).toBe('Nguyễn Văn Khách');

        // Bank account in the verified name only.
        expectStatus(await put('/customer/wallet/bank-account', customer, { bankBin: '970436', accountNumber: '0123456789', accountName: 'TRAN THI KHAC' }), 422);
        expect(unwrap((await put('/customer/wallet/bank-account', customer, { bankBin: '970436', accountNumber: '0123456789', accountName: 'nguyen van khach' }).expect(200)).body)).toMatchObject({ bankName: 'Vietcombank', accountName: 'NGUYEN VAN KHACH' });

        // Withdraw the whole balance; below the minimum and above the balance are refused.
        expectStatus(await post('/customer/wallet/withdrawals', customer, { amount: 9999 }), 400);
        expectStatus(await post('/customer/wallet/withdrawals', customer, { amount: 150001 }), 422);
        createPayout.mockResolvedValueOnce({ payoutId: 'po_e2e', outcome: 'SUCCEEDED', providerState: 'SUCCEEDED', bankReference: 'FT-E2E', failureReason: null });
        const done = unwrap((await post('/customer/wallet/withdrawals', customer, { amount: 150000 }).expect(201)).body);
        expect(done).toMatchObject({ status: 'SUCCESS', amount: 150000, bankAccountNumber: '••••6789', payoutBankReference: 'FT-E2E' });
        expect(createPayout.mock.calls[0][0]).toMatchObject({ amount: 150000, toBin: '970436', toAccountNumber: '0123456789', referenceId: done.id.replace(/-/g, '') });
        const emptied = unwrap((await get('/customer/wallet', customer).expect(200)).body);
        expect(emptied.balance).toBe(0);
        expect(emptied.transactions[0]).toMatchObject({ type: 'withdrawal', amount: 150000 });

        // A refused payout returns the money exactly once.
        await adjust(60000);
        createPayout.mockRejectedValueOnce(new payoutModule.PayoutRejectedError('Tài khoản nhận không hợp lệ'));
        const failed = unwrap((await post('/customer/wallet/withdrawals', customer, { amount: 60000 }).expect(201)).body);
        expect(failed).toMatchObject({ status: 'FAILED', failureReason: 'Tài khoản nhận không hợp lệ' });
        expect(unwrap((await get('/customer/wallet', customer).expect(200)).body).balance).toBe(60000);
        const refunds = await db.query("SELECT amount FROM customer_wallet_transactions WHERE type = 'withdrawal_refund' AND reference_id = $1", [failed.id]);
        expect(refunds.map((r: any) => Number(r.amount))).toEqual([60000]);
        const history = unwrap((await get('/customer/wallet/withdrawals?page=1&limit=10', customer).expect(200)).body);
        expect(history.map((w: any) => w.status)).toEqual(['FAILED', 'SUCCESS']);
        denied(await get('/customer/wallet/withdrawals', admin));

        // Staff see customer withdrawals on their own list, never mixed with technicians' (PO 16/10/2026).
        for (const staff of [manager, admin]) {
          const mine = unwrap((await get('/service-manager/customer-withdrawals?page=1&limit=20', staff).expect(200)).body)
            .filter((w: any) => w.customer?.id === customer.user.id);
          expect(mine.map((w: any) => w.status)).toEqual(['FAILED', 'SUCCESS']);
          expect(mine[0]).toMatchObject({ amount: 60000, bankAccountNumber: '••••6789', failureReason: 'Tài khoản nhận không hợp lệ', customer: { fullName: 'Nguyễn Văn Khách' } });
          const technicianIds = unwrap((await get('/service-manager/withdrawals?page=1&limit=100', staff).expect(200)).body).map((w: any) => w.id);
          expect(technicianIds).not.toContain(done.id);
          expect(technicianIds).not.toContain(failed.id);
        }
        const searched = unwrap((await get(`/service-manager/customer-withdrawals?status=FAILED&search=${encodeURIComponent('nguyen van khach')}`, manager).expect(200)).body);
        expect(searched.map((w: any) => w.id)).toEqual([failed.id]);
        const totals = unwrap((await get('/service-manager/customer-withdrawals/payout-overview', manager).expect(200)).body);
        expect(totals).toMatchObject({ sourceBalance: 100_000_000 });
        expect(totals.paidOut.amount).toBeGreaterThanOrEqual(150000);
        expect(totals.failed.count).toBeGreaterThanOrEqual(1);
        expect(unwrap((await post(`/service-manager/customer-withdrawals/${done.id}/reconcile`, manager).expect(200)).body)).toMatchObject({ id: done.id, status: 'SUCCESS', customer: { id: customer.user.id } });
        denied(await get('/service-manager/customer-withdrawals', customer));
      } finally {
        spies.forEach((spy) => spy.mockRestore());
        Object.defineProperty(provider, 'name', { value: originalName, configurable: true, writable: true });
      }
    });

    // PO 18/10/2026 ------------------------------------------------------------------------------
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(24)]);
    const upload = (path: string, session: Session, file: Buffer, filename: string, contentType: string) =>
      request(context().app.getHttpServer()).post(`/api/v1${path}`).set('Authorization', `Bearer ${session.accessToken}`).attach('file', file, { filename, contentType });
    const mockBookingMediaStorage = () => {
      const { PrivateBookingPhotoStorage } = runtimeRequire('./dist/modules/media/private-booking-photo-storage.service.js');
      const media = context().app.get(PrivateBookingPhotoStorage);
      return [
        vi.spyOn(media, 'upload').mockImplementation(async () => `cloudinary://booking-photos/test/${randomUUID()}`),
        vi.spyOn(media, 'uploadVideo').mockImplementation(async () => `cloudinary://booking-videos/test/${randomUUID()}`),
        vi.spyOn(media, 'download').mockImplementation(async (ref: any) => String(ref).includes('booking-videos') ? { buffer: mp4, mimeType: 'video/mp4' } : { buffer: png, mimeType: 'image/png' }),
      ];
    };
    /** A completed order paid from the customer wallet, the technician's labor warranty on it. */
    async function completedOrder(f: Awaited<ReturnType<typeof fixture>>) {
      const put = (path: string, session: Session, body: object) => request(context().app.getHttpServer()).put(`/api/v1${path}`).set('Authorization', `Bearer ${session.accessToken}`).send(body);
      await context().db.getRepository('TechnicianSkill').update({ serviceId: f.service.id }, { typicalWarrantyDays: null });
      await put('/technicians/me/warranty-default', f.tech, { days: 30 }).expect(200);
      const { order, booking } = await accept(f), path = `/service-orders/${order.id}`;
      await arrived(order.id, f.tech);
      await evidence(order.id, f.tech, 'after').expect(201);
      await post(path + '/request-completion', f.tech).expect(200);
      const invoice = unwrap((await get(path + '/invoice', f.owner).expect(200)).body);
      return { order, booking, invoice, path };
    }

    it('shows the invited technician the problem, photos, videos and how far it is, never the address (PO 18/10/2026)', async () => {
      const spies = mockBookingMediaStorage();
      try {
        const f = await fixture();
        // Upload rules: a customer only; a video must be a video by its bytes.
        denied(await upload('/media/booking-video-upload', f.tech, mp4, 'clip.mp4', 'video/mp4'));
        expect((await upload('/media/booking-video-upload', f.owner, png, 'clip.mp4', 'video/mp4')).status).toBe(400);
        const photo = unwrap((await upload('/media/booking-photo-upload', f.owner, png, 'leak.png', 'image/png').expect(201)).body);
        const video = unwrap((await upload('/media/booking-video-upload', f.owner, mp4, 'leak.mov', 'video/quicktime').expect(201)).body);
        expect(video).toMatchObject({ mimeType: 'video/mp4', sizeBytes: mp4.length });
        const created = await post('/bookings', f.owner, { ...f.body, description: 'Vòi rửa chén rỉ nước dưới chân 💧, cần gấp gọi 0912 345 678', customerNote: 'Mã cổng 4321, gọi 0909123456', photoUploadIds: [photo.uploadId, video.uploadId] });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const booking = unwrap(created.body);
        await post(`/bookings/${booking.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id, f.spare.user.id] }).expect(201);

        const [invitation] = unwrap((await get('/invitations/my', f.tech).expect(200)).body);
        // The number typed into the description is hidden; the distance is a coarse band (same spot: under 1 km).
        expect(invitation.booking).toMatchObject({ id: booking.id, description: 'Vòi rửa chén rỉ nước dưới chân 💧, cần gấp gọi [số điện thoại ẩn]', district: expect.any(String), distanceBand: { minKm: 0, maxKm: 1 } });
        expect(JSON.stringify(invitation)).not.toContain('345 678');
        expect(invitation.booking.media.map((m: any) => [m.mimeType, m.isPrivate, m.url])).toEqual(expect.arrayContaining([['image/png', true, null], ['video/mp4', true, null]]));
        const preview = unwrap((await get(`/bookings/${booking.id}`, f.tech).expect(200)).body);
        expect(preview.media).toHaveLength(2);
        expect(preview.media.every((m: any) => m.isPrivate === true && m.legacyInsecure === false)).toBe(true);
        for (const body of [invitation, preview]) {
          const text = JSON.stringify(body);
          expect(text).not.toContain('1 Test Street');
          expect(text).not.toContain('4321');
          expect(text).not.toContain('0909123456');
          expect(text).not.toMatch(/latitude|longitude|addressText|customerId|phone/i);
        }

        const videoMedia = preview.media.find((m: any) => m.mimeType === 'video/mp4');
        const content = await get(`/bookings/${booking.id}/media/${videoMedia.id}/content`, f.tech).expect(200);
        expect(content.headers['content-type']).toBe('video/mp4');
        expect(content.headers['cache-control']).toContain('no-store');
        // The technician waiting on standby is not invited yet: nothing.
        await get(`/bookings/${booking.id}/media/${videoMedia.id}/content`, f.spare).expect(404);
        await get(`/bookings/${booking.id}`, f.spare).expect(404);
        expect(unwrap((await get('/invitations/my', f.spare).expect(200)).body)).toEqual([]);

        // Once they decline, the photos close for them and open for the next one invited.
        await post(`/invitations/${invitation.id}/respond`, f.tech, { action: 'DECLINE' }).expect(200);
        await get(`/bookings/${booking.id}/media/${videoMedia.id}/content`, f.tech).expect(404);
        await get(`/bookings/${booking.id}`, f.tech).expect(404);
        const [next] = unwrap((await get('/invitations/my', f.spare).expect(200)).body);
        expect(next.booking.id).toBe(booking.id);
        await get(`/bookings/${booking.id}/media/${videoMedia.id}/content`, f.spare).expect(200);
        // A third video is refused at booking time.
        const videos = [];
        for (let i = 0; i < 3; i++) videos.push(unwrap((await upload('/media/booking-video-upload', f.owner, mp4, `v${i}.mp4`, 'video/mp4').expect(201)).body).uploadId);
        const third = await post('/bookings', f.owner, { ...f.body, photoUploadIds: videos });
        expect(third.status, JSON.stringify(third.body)).toBe(422);
        expect(third.body.error.code).toBe('VALIDATION_FAILED');
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    it('closes the chat when the order is completed and opens it again while a warranty claim is open (PO 18/10/2026)', async () => {
      const f = await fixture(), db = context().db;
      const { ChatAttachmentStorage } = runtimeRequire('./dist/modules/messaging/chat-attachment-storage.service.js');
      const chatStorage = context().app.get(ChatAttachmentStorage);
      const spies = [
        vi.spyOn(chatStorage, 'upload').mockImplementation(async (conversationId: any, kind: any) => `cloudinary://chat-media/${kind}/fixhome/chat-media/${conversationId}/${randomUUID()}`),
        vi.spyOn(chatStorage, 'download').mockImplementation(async () => ({ buffer: png, mimeType: 'image/png' })),
      ];
      try {
        const { order, invoice } = await completedOrder(f);
        const thread = async (session: Session) => unwrap((await get('/conversations', session).expect(200)).body).find((c: any) => c.serviceOrderId === order.id);
        const conversation = await thread(f.owner);
        expect(conversation).toMatchObject({ canSend: true, closedReason: null });

        // Photos and videos go into the thread while the job runs.
        const sent = await request(context().app.getHttpServer()).post(`/api/v1/conversations/${conversation.id}/attachments`).set('Authorization', `Bearer ${f.owner.accessToken}`)
          .field('content', 'Chỗ rò đây ạ').field('clientMessageId', 'att-1').attach('file', png, { filename: 'leak.png', contentType: 'image/png' });
        expect(sent.status, JSON.stringify(sent.body)).toBe(201);
        const message = unwrap(sent.body);
        expect(message).toMatchObject({ content: 'Chỗ rò đây ạ', attachment: { kind: 'image', mimeType: 'image/png' } });
        expect(JSON.stringify(sent.body)).not.toContain('cloudinary://');
        const clip = await request(context().app.getHttpServer()).post(`/api/v1/conversations/${conversation.id}/attachments`).set('Authorization', `Bearer ${f.tech.accessToken}`)
          .attach('file', mp4, { filename: 'clip.mp4', contentType: 'video/mp4' });
        expect(clip.status, JSON.stringify(clip.body)).toBe(201);
        expect(unwrap(clip.body).attachment.kind).toBe('video');
        const notMedia = await request(context().app.getHttpServer()).post(`/api/v1/conversations/${conversation.id}/attachments`).set('Authorization', `Bearer ${f.owner.accessToken}`)
          .attach('file', Buffer.from('%PDF-1.7'), { filename: 'a.pdf', contentType: 'application/pdf' });
        expect(notMedia.status).toBe(400);
        const extra = await request(context().app.getHttpServer()).post(`/api/v1/conversations/${conversation.id}/attachments`).set('Authorization', `Bearer ${f.owner.accessToken}`)
          .field('isAutomated', 'true').attach('file', png, { filename: 'leak.png', contentType: 'image/png' });
        expect(extra.status).toBe(400); // a field the route does not take is refused by the whitelist
        const bytes = await get(`/messages/${message.id}/attachment`, f.tech).expect(200);
        expect(bytes.headers['content-type']).toBe('image/png');
        await get(`/messages/${message.id}/attachment`, f.outsider).expect(404);
        expect((await request(context().app.getHttpServer()).post(`/api/v1/conversations/${conversation.id}/attachments`).set('Authorization', `Bearer ${f.outsider.accessToken}`).attach('file', png, { filename: 'x.png', contentType: 'image/png' })).status).toBe(404);
        const listed = unwrap((await get(`/conversations/${conversation.id}/messages`, f.tech).expect(200)).body);
        expect(listed.find((m: any) => m.id === message.id)).toMatchObject({ attachment: { kind: 'image' } });

        // Paid: the order completes and the chat closes for both sides, calls included.
        await db.query('INSERT INTO customer_wallets (user_id, balance) VALUES ($1, $2)', [f.owner.user.id, 1000000]);
        await post(`/invoices/${invoice.id}/pay-with-wallet`, f.owner).expect(200);
        expect(await thread(f.owner)).toMatchObject({ canSend: false, closedReason: 'order_completed', status: 'active' });
        expect(await thread(f.tech)).toMatchObject({ canSend: false, closedReason: 'order_completed' });
        for (const session of [f.owner, f.tech]) {
          const refused = await post(`/conversations/${conversation.id}/messages`, session, { content: 'Còn đó không?' });
          expect(refused.status).toBe(409);
          expect(refused.body.error.code).toBe('CONVERSATION_CLOSED');
        }
        const closedAttach = await request(context().app.getHttpServer()).post(`/api/v1/conversations/${conversation.id}/attachments`).set('Authorization', `Bearer ${f.owner.accessToken}`).attach('file', png, { filename: 'x.png', contentType: 'image/png' });
        expect(closedAttach.status).toBe(409);
        expect(closedAttach.body.error.code).toBe('CONVERSATION_CLOSED');
        // History stays readable.
        await get(`/conversations/${conversation.id}/messages`, f.owner).expect(200);
        await get(`/messages/${message.id}/attachment`, f.owner).expect(200);

        // A warranty claim opens it again for as long as the claim is in progress.
        const [coverage] = unwrap((await get(`/service-orders/${order.id}/warranties`, f.owner).expect(200)).body);
        const claim = unwrap((await post(`/service-orders/${order.id}/warranty-claims`, f.owner, { warrantyCoverageId: coverage.id, description: 'Vòi lại rỉ nước sau hai ngày' }).expect(201)).body);
        expect(await thread(f.owner)).toMatchObject({ canSend: true, closedReason: null });
        await post(`/conversations/${conversation.id}/messages`, f.owner, { content: 'Anh ơi vòi lại rỉ ạ' }).expect(201);
        await post(`/conversations/${conversation.id}/messages`, f.tech, { content: 'Chiều nay em ghé xem' }).expect(201);

        // Rejected by the manager: closed again.
        const manager = await context().register();
        await db.query('UPDATE users SET role = $1 WHERE id = $2', ['service_manager', manager.user.id]);
        const rejected = await post(`/service-manager/warranty-claims/${claim.id}/reject`, manager, { reasonCode: 'customer_misuse', customerNote: 'Vòi bị va đập mạnh từ bên ngoài' });
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
        expect(await thread(f.tech)).toMatchObject({ canSend: false, closedReason: 'order_completed' });
        expect((await post(`/conversations/${conversation.id}/messages`, f.tech, { content: 'Dạ' })).status).toBe(409);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    it("puts a paid order's share in the technician wallet once a completion hold is lifted, once only (PO 18/10/2026)", async () => {
      const f = await fixture(), db = context().db;
      const { ServiceOrdersService } = runtimeRequire('./dist/modules/service-orders/service-orders.service.js');
      const orders = context().app.get(ServiceOrdersService);
      const { order, invoice } = await completedOrder(f);
      // A complaint holds completion when the customer pays.
      const opened = unwrap((await post('/support/cases', f.owner, { caseType: 'quality', reason: 'Máy vẫn kêu khi chạy', serviceOrderId: order.id }).expect(201)).body);
      await db.query('UPDATE support_cases SET hold_completion = true WHERE id = $1', [opened.id]);
      await db.query('INSERT INTO customer_wallets (user_id, balance) VALUES ($1, $2)', [f.owner.user.id, 1000000]);
      await post(`/invoices/${invoice.id}/pay-with-wallet`, f.owner).expect(200);
      const ledger = () => db.query("SELECT t.type, t.amount FROM wallet_transactions t JOIN wallets w ON w.id = t.wallet_id WHERE w.technician_id = $1 AND t.reference_id = $2", [f.tech.user.id, order.id]);
      expect(unwrap((await get(`/service-orders/${order.id}`, f.owner).expect(200)).body)).toMatchObject({ status: 'under_repair', paymentStatus: 'paid' });
      expect(await ledger()).toHaveLength(0);
      // Held: the sweep leaves it.
      await orders.sweepPaidOrders();
      expect(unwrap((await get(`/service-orders/${order.id}`, f.owner).expect(200)).body).status).toBe('under_repair');
      expect(await ledger()).toHaveLength(0);

      // The manager lifts the hold (as PATCH .../hold does); nothing ran completion again before 18/10/2026.
      await db.query('UPDATE support_cases SET hold_completion = false WHERE id = $1', [opened.id]);
      const first = await orders.sweepPaidOrders();
      expect(first.completed).toBeGreaterThanOrEqual(1);
      expect(unwrap((await get(`/service-orders/${order.id}`, f.owner).expect(200)).body).status).toBe('completed');
      const [paidInvoice] = await db.query('SELECT grand_total, commission_amount, fixhome_parts_total, shipping_fee FROM invoices WHERE id = $1', [invoice.id]);
      const share = Number(paidInvoice.grand_total) - Number(paidInvoice.commission_amount) - Number(paidInvoice.fixhome_parts_total) - Number(paidInvoice.shipping_fee);
      expect(share).toBeGreaterThan(0);
      expect((await ledger()).map((t: any) => [t.type, Number(t.amount)])).toEqual([['ONLINE_EARNING', share]]);
      // Again and again: nothing more.
      await orders.sweepPaidOrders();
      await orders.sweepPaidOrders();
      expect(await ledger()).toHaveLength(1);
    });

    it('settles an order recorded completed and paid before settlement existed (PO 18/10/2026)', async () => {
      const f = await fixture(), db = context().db;
      const { ServiceOrdersService } = runtimeRequire('./dist/modules/service-orders/service-orders.service.js');
      const orders = context().app.get(ServiceOrdersService);
      const legacy = await completedOrder(f);
      await db.query("UPDATE invoices SET payment_status = 'paid', paid_at = now() WHERE id = $1", [legacy.invoice.id]);
      await db.query("UPDATE service_orders SET status = 'completed', payment_status = 'paid', completed_at = now() WHERE id = $1", [legacy.order.id]);
      const settledLegacy = await orders.sweepPaidOrders();
      expect(settledLegacy.settled).toBeGreaterThanOrEqual(1);
      const legacyLedger = await db.query("SELECT t.type FROM wallet_transactions t WHERE t.reference_id = $1", [legacy.order.id]);
      expect(legacyLedger.map((t: any) => t.type)).toEqual(['ONLINE_EARNING']);
    });
  });

  describe('AI assistant is rate limited per customer', () => {
    it('stops one customer at the limit without touching another', async () => {
      const { AiDiagnosisService } = runtimeRequire('./dist/modules/ai-diagnosis/ai-diagnosis.service.js');
      const { AI_ASK_PER_MINUTE } = runtimeRequire('./dist/modules/ai-diagnosis/ai-throttler.guard.js');
      const { of } = runtimeRequire('rxjs');
      const http = (context().app.get(AiDiagnosisService) as any).httpService;
      const spy = vi.spyOn(http, 'post').mockImplementation((() =>
        of({ data: { sessionId: `ai-${randomUUID()}`, status: 'ok', answerVi: 'Dạ.', recommendedServices: [] } })) as any);
      try {
        const busy = await context().register();
        const other = await context().register();
        const ask = (session: Session) =>
          request(context().app.getHttpServer()).post('/api/v1/ai/chat/ask')
            .set('Authorization', `Bearer ${session.accessToken}`)
            .send({ question: 'máy lạnh không mát' });
        for (let i = 0; i < AI_ASK_PER_MINUTE; i += 1) {
          await ask(busy).expect(200);
        }
        await ask(busy).expect(429);
        await ask(other).expect(200);
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps a customer\'s verdict on their own conversation and shows it to an admin', async () => {
      const { AiDiagnosisService } = runtimeRequire('./dist/modules/ai-diagnosis/ai-diagnosis.service.js');
      const { of } = runtimeRequire('rxjs');
      const http = (context().app.get(AiDiagnosisService) as any).httpService;
      const sessionId = `ai-${randomUUID()}`;
      const spy = vi.spyOn(http, 'post').mockImplementation((() =>
        of({ data: { sessionId, status: 'ok', answerVi: 'Dạ khả năng cao là thiếu gas.', recommendedServices: [] } })) as any);
      const post = (path: string, session: Session, body: object = {}) => request(context().app.getHttpServer()).post(`/api/v1${path}`).set('Authorization', `Bearer ${session.accessToken}`).send(body);
      const get = (path: string, session: Session) => request(context().app.getHttpServer()).get(`/api/v1${path}`).set('Authorization', `Bearer ${session.accessToken}`);
      const denied = (response: request.Response) => expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
      try {
        const owner = await context().register();
        const stranger = await context().register();
        await post('/ai/chat/ask', owner, { question: 'máy lạnh không mát, mới vệ sinh rồi' }).expect(200);
        const verdict = { sessionId, verdict: 'wrong', note: 'em đã nói vệ sinh rồi', reply: 'Dạ khả năng cao là thiếu gas.' };
        await post('/ai/feedback', stranger, verdict).expect(404);
        await post('/ai/feedback', owner, verdict).expect(200);
        await post('/ai/feedback', owner, { ...verdict, verdict: 'maybe' }).expect(400);
        await post('/ai/feedback', owner, { sessionId: 'never-recorded', verdict: 'wrong' }).expect(404);
        denied(await get('/admin/ai-quality', owner));
        await context().db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', stranger.user.id]);
        const quality = unwrap((await get('/admin/ai-quality?days=1', stranger).expect(200)).body);
        expect(quality.totals.markedWrong).toBeGreaterThanOrEqual(1);
        expect(quality.recentWrong.some((r: any) => r.sessionId === sessionId && r.note === 'em đã nói vệ sinh rồi')).toBe(true);
        expect(quality.perDay.length).toBeGreaterThanOrEqual(1);
        const week = unwrap((await get('/admin/ai-quality?days=7', stranger).expect(200)).body);
        const todayVn = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
        expect(week.perDay).toHaveLength(7);
        expect(week.perDay.at(-1).day).toBe(todayVn);
        expect(week.perDay.at(-1).sessions).toBeGreaterThanOrEqual(1);
        const [row] = await context().db.query('SELECT summary FROM ai_chat_sessions WHERE session_id = $1', [sessionId]);
        expect(row.summary.feedback).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('AI assistant keeps the conversation across a lost AI session', () => {
    // Real HTTP, JWT and Postgres; only the AI Service transport is replaced, so
    // what is checked is what the backend sends and records.
    it('rebuilds a lost session from the recorded turns, for the owner only', async () => {
      const { AiDiagnosisService } = runtimeRequire('./dist/modules/ai-diagnosis/ai-diagnosis.service.js');
      const { of } = runtimeRequire('rxjs');
      // The HttpService instance this module was given; other modules have their own.
      const http = (context().app.get(AiDiagnosisService) as any).httpService;
      const sent: Array<Record<string, any>> = [];
      let next = 0;
      const ids = [`ai-${randomUUID()}`, `ai-${randomUUID()}`, `ai-${randomUUID()}`];
      const spy = vi.spyOn(http, 'post').mockImplementation(((_url: string, body: Record<string, any>) => {
        sent.push(body);
        return of({ data: { sessionId: ids[next++], status: 'ok', answerVi: 'Dạ.', messageVi: 'Dạ.', suspectedFaults: [], recommendedServices: [] } });
      }) as any);
      try {
        const owner = await context().register();
        const other = await context().register();
        const ask = (session: Session, question: string, sessionId?: string) =>
          request(context().app.getHttpServer()).post('/api/v1/ai/chat/ask')
            .set('Authorization', `Bearer ${session.accessToken}`)
            .send({ question, ...(sessionId ? { sessionId } : {}) });

        await ask(owner, 'máy lạnh không mát').expect(200);
        expect(sent[0]).not.toHaveProperty('history');
        // The AI lost ids[0] and answers under ids[1]; the backend must have sent
        // what was said before, from its own record.
        await ask(owner, 'mới vệ sinh rồi', ids[0]).expect(200);
        expect(sent[1].history).toEqual(['máy lạnh không mát']);
        const [row] = await context().db.query('SELECT customer_id, summary FROM ai_chat_sessions WHERE session_id = $1', [ids[1]]);
        expect(row.customer_id).toBe(owner.user.id);
        expect(row.summary.customerText).toBe('máy lạnh không mát / mới vệ sinh rồi');
        expect(row.summary.turnCount).toBe(2);

        // Someone else holding the id gets no history and writes nothing into it.
        await ask(other, 'vậy giờ là bị gì', ids[1]).expect(200);
        expect(sent[2]).not.toHaveProperty('history');
        const [after] = await context().db.query('SELECT customer_id, summary FROM ai_chat_sessions WHERE session_id = $1', [ids[1]]);
        expect(after.summary.turnCount).toBe(2);
        const [stranger] = await context().db.query('SELECT customer_id, summary FROM ai_chat_sessions WHERE session_id = $1', [ids[2]]);
        expect(stranger.customer_id).toBe(other.user.id);
        expect(stranger.summary.customerText).toBe('vậy giờ là bị gì');
      } finally {
        spy.mockRestore();
      }
    });
  });
}
