import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

type Session = { accessToken: string; user: { id: string } };
type Context = { app: INestApplication; db: DataSource; register: () => Promise<Session>; technician: Session; admin: Session };
const runtimeRequire = createRequire(resolve('package.json'));

/** Runs ONLY inside the existing real PostgreSQL/private-schema HTTP harness in CI.
 * No new server, database, provider stub or migration runner is introduced here. */
export function registerBookingDraftCases(context: () => Context) {
  describe('P2 manual booking draft HTTP/PostgreSQL gate', () => {
    const http = (method: 'get' | 'put' | 'delete' | 'post', path: string, actor?: Session, body?: object) => {
      const call = request(context().app.getHttpServer())[method](`/api/v1/booking-drafts/${path}`);
      if (actor) call.set('Authorization', `Bearer ${actor.accessToken}`);
      return body ? call.send(body) : call;
    };
    const save = (owner: Session, snapshot = {}, expectedVersion: number | null = null) => http('put', 'current', owner, { snapshot, expectedVersion });
    const get = (owner: Session) => http('get', 'current', owner);
    const submit = (owner: Session, id: string, body: object) => http('post', `${id}/submit`, owner, body);
    async function fixture() {
      const { db, register } = context();
      // Refuse reuse against an application/shared schema even if this helper is imported elsewhere.
      if (db.options.type !== 'postgres' || typeof db.options.schema !== 'string' || !db.options.schema.startsWith('member1_e2e_')) {
        throw new Error('Booking draft cases require the existing disposable E2E schema');
      }
      const owner = await register();
      const category = await db.getRepository('ServiceCategory').save({ name: 'P2 synthetic category', code: `P2-${randomUUID()}`, isActive: true });
      const service = await db.getRepository('Service').save({ categoryId: category.id, name: 'P2 synthetic fixed service',
        code: `P2-${randomUUID()}`, pricingMode: 'fixed_price', fixedPrice: 199000, isActive: true });
      const address = await db.getRepository('Address').save({ userId: owner.user.id, line1: 'Synthetic test location',
        district: 'Quận 1', province: 'Hồ Chí Minh', lat: 10.77, lng: 106.69 });
      const start = new Date(Date.now() + 2 * 86_400_000);
      const data = { serviceId: service.id, addressId: address.id, preferredStartAt: start.toISOString(),
        preferredEndAt: new Date(+start + 3600_000).toISOString(), quantity: 1 };
      const body = { expectedVersion: 1, operationKey: randomUUID(), request: { kind: 'booking', data } };
      const draft = async (snapshot = {}) => (await save(owner, snapshot).expect(200)).body.data;
      return { db, owner, service, address, data, body, draft };
    }

    it('enforces JWT and CUSTOMER RBAC for every route', async () => {
      const id = randomUUID();
      for (const [method, path, body] of [
        ['get', 'current', undefined], ['put', 'current', { snapshot: {}, expectedVersion: null }],
        ['delete', 'current', undefined], ['post', `${id}/submit`, {}],
      ] as const) {
        await http(method, path, undefined, body).expect(401);
        for (const actor of [context().technician, context().admin]) await http(method, path, actor, body).expect(403);
      }
    });

    it('saves canonical flat JSON across devices with one row, no booking/order/invitation/payment effects', async () => {
      const f = await fixture();
      const counts = () => f.db.query(`SELECT (SELECT count(*)::int FROM bookings) AS bookings,
        (SELECT count(*)::int FROM service_orders) AS orders,
        (SELECT count(*)::int FROM booking_invitations) AS invitations,
        (SELECT count(*)::int FROM payments) AS payments`);
      const before = await counts();
      const snapshot = { kind: 'visit_group', step: 2, savedDeviceCount: 1, quantity: 1,
        addressId: f.address.id, items: [{ serviceId: f.service.id, selectedVariantCode: null }, { description: 'Máy đang soạn' }] };
      const saved = await f.draft(snapshot);
      expect(saved.version).toBe(1);
      expect(saved.snapshot.items[0]).not.toHaveProperty('selectedVariantCode');
      const read = await get(f.owner).expect(200);
      expect(read.headers['cache-control']).toBe('no-store'); expect(read.body.data).toEqual(saved);
      const latest = (await save(f.owner, { ...snapshot, step: 3 }, 1).expect(200)).body.data;
      expect(latest.id).toBe(saved.id); expect(latest.version).toBe(2);
      expect(await counts()).toEqual(before);
      expect(await f.db.getRepository('BookingDraft').count({ where: { customerId: f.owner.user.id } })).toBe(1);
      for (const wrong of [{ activeDevice: {} }, { items: Array(6).fill({}) }, { customerNote: 'x'.repeat(1001) }]) {
        await save(f.owner, wrong, 2).expect(400);
      }
    });

    it('isolates customers and serializes concurrent manual saves with optimistic version conflicts', async () => {
      const f = await fixture(); const other = await context().register();
      const a = await f.draft();
      expect((await get(other).expect(200)).body.data).toBeNull();
      expect((await http('delete', 'current', other).expect(200)).body.data.deleted).toBe(false);
      await save(other, { addressId: f.address.id }).expect(403);
      await submit(other, a.id, f.body).expect(409);
      const responses = await Promise.all([save(f.owner, { customerNote: 'A' }, 1), save(f.owner, { customerNote: 'B' }, 1)]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      expect((await get(f.owner)).body.data.version).toBe(2);
      const second = await save(other).expect(200);
      expect(second.body.data.id).not.toBe(a.id);
    });

    it('expires after 30 days without GET refresh and strips 2-hour upload references without claiming', async () => {
      const f = await fixture();
      const upload = await f.db.getRepository('PrivateBookingPhotoUpload').save({ ownerUserId: f.owner.user.id,
        objectRef: `synthetic-p2-${randomUUID()}`, mimeType: 'image/jpeg', sizeBytes: 100,
        expiresAt: new Date(Date.now() + 2 * 3600_000), claimedBookingId: null });
      const saved = await f.draft({ items: [{ photoUploadIds: [upload.id] }] });
      expect(Math.abs(Date.parse(saved.expiresAt) - Date.now() - 30 * 86_400_000)).toBeLessThan(5000);
      await f.db.query('UPDATE booking_media_uploads SET expires_at = now() - interval \'1 second\' WHERE id = $1', [upload.id]);
      const read = (await get(f.owner)).body.data;
      expect(read.snapshot.items[0].photoUploadIds).toEqual([]); expect(read.expiresAt).toBe(saved.expiresAt);
      expect((await f.db.getRepository('PrivateBookingPhotoUpload').findOneByOrFail({ id: upload.id })).claimedBookingId).toBeNull();
      await f.db.query(`UPDATE booking_drafts SET created_at = now() - interval '31 days',
        updated_at = now() - interval '31 days', expires_at = now() - interval '1 second' WHERE id = $1`, [saved.id]);
      expect((await get(f.owner)).body.data).toBeNull();
      await submit(f.owner, saved.id, f.body).expect(409);
      await save(f.owner, {}, 1).expect(409);
      expect((await f.draft()).id).not.toBe(saved.id);
    });

    it('commits a single target under double submit, retains A across B and rejects changed request/version/key', async () => {
      const f = await fixture(); const a = await f.draft();
      const pair = await Promise.all([submit(f.owner, a.id, f.body), submit(f.owner, a.id, f.body)]);
      expect(pair.map(response => response.status)).toEqual([200, 200]);
      const result = pair[0].body.data;
      expect(pair[1].body.data).toEqual(result);
      expect(result).toEqual({ kind: 'booking', bookingId: expect.any(String), visitGroupId: null });
      const b = await f.draft({ customerNote: 'B' });
      expect(b.id).not.toBe(a.id);
      expect((await submit(f.owner, a.id, f.body).expect(200)).body.data).toEqual(result);
      expect((await get(f.owner)).body.data.id).toBe(b.id);
      for (const changed of [{ ...f.body, expectedVersion: 2 }, { ...f.body, operationKey: randomUUID() },
        { ...f.body, request: { ...f.body.request, data: { ...f.data, quantity: 2 } } }]) {
        await submit(f.owner, a.id, changed).expect(409);
      }
      expect(await f.db.getRepository('Booking').count({ where: { customerId: f.owner.user.id } })).toBe(1);
      expect(await f.db.getRepository('BookingDraftSubmitReceipt').count({ where: { customerId: f.owner.user.id } })).toBe(1);
      await http('delete', 'current', f.owner).expect(200);
      expect((await submit(f.owner, a.id, f.body).expect(200)).body.data).toEqual(result);
      await expect(f.db.query('UPDATE booking_draft_submit_receipts SET request_fingerprint = $1 WHERE draft_id = $2', ['0'.repeat(64), a.id])).rejects.toThrow();
      await expect(f.db.query('DELETE FROM booking_draft_submit_receipts WHERE draft_id = $1', [a.id])).rejects.toThrow();
    });

    it('rolls back target, audit, photo claim and consumption when receipt insertion fails', async () => {
      const f = await fixture(); const draft = await f.draft();
      const upload = await f.db.getRepository('PrivateBookingPhotoUpload').save({ ownerUserId: f.owner.user.id,
        objectRef: `synthetic-p2-${randomUUID()}`, mimeType: 'image/jpeg', sizeBytes: 100,
        expiresAt: new Date(Date.now() + 2 * 3600_000), claimedBookingId: null });
      await f.db.query(`CREATE FUNCTION p2_test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'P2 receipt test failure' USING ERRCODE = '23514'; END; $$`);
      await f.db.query(`CREATE TRIGGER p2_test_fail_receipt BEFORE INSERT ON booking_draft_submit_receipts
        FOR EACH ROW EXECUTE FUNCTION p2_test_fail_receipt()`);
      const body = { ...f.body, request: { kind: 'booking', data: { ...f.data, photoUploadIds: [upload.id] } } };
      try {
        await submit(f.owner, draft.id, body).expect(400);
        expect((await get(f.owner)).body.data.id).toBe(draft.id);
        expect(await f.db.getRepository('Booking').count({ where: { customerId: f.owner.user.id } })).toBe(0);
        expect(await f.db.getRepository('BookingDraftSubmitReceipt').count({ where: { customerId: f.owner.user.id } })).toBe(0);
        expect(await f.db.getRepository('AuditLog').count({ where: { actorUserId: f.owner.user.id, action: 'BOOKING_CREATE' } })).toBe(0);
        expect((await f.db.getRepository('PrivateBookingPhotoUpload').findOneByOrFail({ id: upload.id })).claimedBookingId).toBeNull();
      } finally {
        await f.db.query('DROP TRIGGER p2_test_fail_receipt ON booking_draft_submit_receipts');
        await f.db.query('DROP FUNCTION p2_test_fail_receipt()');
      }
      await submit(f.owner, draft.id, body).expect(200);
    });

    it('revalidates service/address/time at submit rather than binding draft contents', async () => {
      const f = await fixture(); const draft = await f.draft({ items: [{ serviceId: f.service.id }] });
      await f.db.getRepository('Service').update(f.service.id, { isActive: false });
      await submit(f.owner, draft.id, f.body).expect(404);
      expect((await get(f.owner)).body.data.id).toBe(draft.id);
      await f.db.getRepository('Service').update(f.service.id, { isActive: true });
      const other = await context().register();
      const foreign = await f.db.getRepository('Address').save({ userId: other.user.id, line1: 'Synthetic other location', district: 'Q1', province: 'HCM', lat: 10, lng: 106 });
      await submit(f.owner, draft.id, { ...f.body, request: { kind: 'booking', data: { ...f.data, addressId: foreign.id } } }).expect(403);
      await submit(f.owner, draft.id, { ...f.body, request: { kind: 'booking', data: { ...f.data, preferredStartAt: '2020-01-01T00:00:00Z' } } }).expect(422);
      expect(await f.db.getRepository('Booking').count({ where: { customerId: f.owner.user.id } })).toBe(0);
    });

    it('creates a five-device group as one pending visit, solo as second, then rejects the third at quota', async () => {
      const f = await fixture();
      const { BusinessConfigService } = runtimeRequire('./dist/modules/system-config/business-config.service.js');
      const config = context().app.get<any>(BusinessConfigService);
      const prior = await f.db.getRepository('SystemConfig').findOneByOrFail({ key: 'visit_group.enabled' });
      await f.db.query('UPDATE system_configs SET value = $1 WHERE key = $2', ['true', 'visit_group.enabled']);
      config.invalidateCache();
      try {
        const groupDraft = await f.draft();
        const { serviceId, quantity: _quantity, ...schedule } = f.data;
        const groupBody = { ...f.body, request: { kind: 'visit_group', data: { ...schedule,
          items: Array.from({ length: 5 }, () => ({ serviceId, deviceLabel: 'Synthetic device' })) } } };
        const group = (await submit(f.owner, groupDraft.id, groupBody).expect(200)).body.data;
        expect(group).toEqual({ kind: 'visit_group', bookingId: null, visitGroupId: expect.any(String) });
        expect(await f.db.getRepository('VisitGroupItem').count({ where: { groupId: group.visitGroupId } })).toBe(5);
        const soloDraft = await f.draft();
        await submit(f.owner, soloDraft.id, f.body).expect(200);
        const third = await f.draft(); // PUT still allowed at quota; it consumes none.
        const rejected = await submit(f.owner, third.id, { ...f.body, operationKey: randomUUID() }).expect(409);
        expect(rejected.body.error.code).toBe('PENDING_VISIT_LIMIT_REACHED');
        expect((await get(f.owner)).body.data.id).toBe(third.id);
        expect(await f.db.getRepository('Booking').count({ where: { customerId: f.owner.user.id } })).toBe(6);
      } finally {
        await f.db.query('UPDATE system_configs SET value = $1 WHERE key = $2', [prior.value, 'visit_group.enabled']);
        config.invalidateCache();
      }
    });
  });
}
