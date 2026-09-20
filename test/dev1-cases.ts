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
    beforeAll(() => {
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
        await save('TechnicianServiceArea', { technicianId: profile.id, provinceCode: 'P1', districtCode: 'D1' });
        for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) await save('TechnicianSchedule', { technicianId: profile.id, dayOfWeek, startTime: '08:00', endTime: '18:00' });
      }
      const start = new Date(); start.setUTCDate(start.getUTCDate() + 2); start.setUTCHours(1, 0, 0, 0);
      const body = { serviceId: service.id, addressId: address.id, description: 'Repair the fixture', quantity: 2, preferredStartAt: start.toISOString(), preferredEndAt: new Date(+start + 3600000).toISOString() };
      const create = async () => { const response = await post('/bookings', owner, body); expect(response.status, JSON.stringify(response.body)).toBe(201); return unwrap(response.body); };
      return { owner, outsider, tech, spare, service, address, body, create };
    }
    async function accept(f: Awaited<ReturnType<typeof fixture>>, booking?: any) {
      booking ??= await f.create();
      await post(`/bookings/${booking.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id] }).expect(201);
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
      for (const booking of [b, b2]) await post(`/bookings/${booking.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id] }).expect(201);
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
      await post(`/bookings/${b.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id] }).expect(201);
      expect(await repo.count({ where: { bookingId: b.id } })).toBe(3);
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
      denied(await post(`/bookings/${newBooking.id}/shortlist`, f.owner, { technicianIds: [f.tech.user.id] }));
      await context().db.getRepository('Service').update(f.service.id, { fixedPrice: 250000 });
      const rebooked = unwrap((await post(`/bookings/${newBooking.id}/rebook`, f.owner, { preferredStartAt: f.body.preferredStartAt, preferredEndAt: f.body.preferredEndAt }).expect(201)).body);
      expect(Number(rebooked.fixedUnitPriceSnapshot)).toBe(250000);
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
