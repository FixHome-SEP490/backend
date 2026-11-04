import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingDraftsService } from './booking-drafts.service';
import { BookingDraft } from './entities/booking-draft.entity';
import { BookingDraftSubmitReceipt } from './entities/booking-draft-submit-receipt.entity';
import { Address } from '../users/entities/address.entity';
import { PrivateBookingPhotoUpload } from '../media/entities/private-booking-photo-upload.entity';
import { Role } from '../../shared/enums';

// Unit persistence double only. Real PostgreSQL locks/rollback are covered by the CI E2E gate.
function fixture() {
  const customer = { id: randomUUID(), role: Role.CUSTOMER };
  const other = { id: randomUUID(), role: Role.CUSTOMER };
  let drafts: any[] = [];
  let receipts: any[] = [];
  let targets: any[] = [];
  const addresses = [{ id: randomUUID(), userId: customer.id }];
  const uploads: any[] = [];
  const events: string[] = [];
  let failReceipt = false;
  let failCreate = false;
  let tail = Promise.resolve();
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]) => row[key] === value);
  const rows = (entity: any) => entity === BookingDraft ? drafts : entity === BookingDraftSubmitReceipt ? receipts
    : entity === Address ? addresses : entity === PrivateBookingPhotoUpload ? uploads : [];
  const manager: any = {
    queryRunner: { isTransactionActive: true },
    query: async (sql: string, params: unknown[]) => {
      expect(sql).toContain('SELECT id FROM users WHERE id = $1 FOR UPDATE');
      events.push('customer-lock');
      return [{ id: params[0] }];
    },
    findOne: async (entity: any, options: any) => {
      if (entity === BookingDraft) { expect(options.lock?.mode).toBe('pessimistic_write'); events.push('draft-lock'); }
      return rows(entity).find(row => matches(row, options.where)) ?? null;
    },
    findOneBy: async (entity: any, where: any) => {
      if (entity === BookingDraftSubmitReceipt) events.push('receipt-read');
      return rows(entity).find(row => matches(row, where)) ?? null;
    },
    create: (_entity: any, value: any) => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...value }),
    save: async (entity: any, value: any) => {
      if (entity === BookingDraftSubmitReceipt && failReceipt) throw new Error('receipt insert failure');
      const list = rows(entity);
      const index = list.findIndex(row => row.id === value.id);
      if (index >= 0) list[index] = structuredClone(value); else list.push(structuredClone(value));
      return value;
    },
    delete: async (entity: any, where: any) => {
      const list = rows(entity);
      const index = list.findIndex(row => matches(row, where));
      if (index >= 0) list.splice(index, 1);
      return { affected: index >= 0 ? 1 : 0 };
    },
  };
  const source: any = {
    transaction: async (work: (manager: any) => Promise<any>) => {
      const prior = tail;
      let release: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await prior;
      const before = structuredClone({ drafts, receipts, targets });
      try { return await work(manager); }
      catch (error) { ({ drafts, receipts, targets } = before); throw error; }
      finally { release!(); }
    },
  };
  const create = async (kind: string, data: any) => {
    events.push('create');
    if (failCreate) throw new Error('create failed');
    const target = { id: randomUUID(), kind, data };
    targets.push(target);
    return target;
  };
  const bookings = { create: vi.fn(async (data: any, actor: any, options: any) => {
    expect(actor).toEqual(customer); expect(options).toEqual({ manager, visitGroupId: null });
    return create('booking', data);
  }) };
  const visits = { create: vi.fn(async (data: any, actor: any, transactionManager: any) => {
    expect(actor).toEqual(customer); expect(transactionManager).toBe(manager);
    return create('visit_group', data);
  }) };
  const service = new BookingDraftsService(source, bookings as never, visits as never);
  const request: any = { kind: 'booking', data: { addressId: addresses[0].id, serviceId: randomUUID(),
    mode: 'scheduled', date: '2030-11-05', slot: 'morning', quantity: 1 } };
  const save = (snapshot = {}, expectedVersion: number | null = null, actor = customer) =>
    service.save({ snapshot, expectedVersion }, actor);
  const submit = (draftId: string, body: any, actor = customer) => service.submit(draftId, body, actor);
  return { service, customer, other, save, submit, request, manager, events, addresses, uploads, bookings, visits,
    state: () => ({ drafts, receipts, targets }), failReceipt: () => { failReceipt = true; }, failCreate: () => { failCreate = true; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T06:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('durable manual draft lifecycle', () => {
  it('saves and restores one draft without creating a target or checking pending quota', async () => {
    const h = fixture();
    const first = await h.save({ customerNote: 'Gọi trước khi đến' });
    expect(first).toMatchObject({ version: 1, expiresAt: '2026-12-04T06:00:00.000Z' });
    expect(await h.service.current(h.customer)).toEqual(first);
    const updated = await h.save({ items: [{}] }, 1);
    expect(updated.id).toBe(first.id); expect(updated.version).toBe(2);
    expect(h.state().drafts).toHaveLength(1); expect(h.state().targets).toEqual([]);
    expect(h.bookings.create).not.toHaveBeenCalled(); expect(h.visits.create).not.toHaveBeenCalled();
  });

  it('resets expiry only on explicit successful save; expires exactly at day 30 with fresh generation', async () => {
    const h = fixture(); const first = await h.save();
    vi.setSystemTime(new Date('2026-12-03T06:00:00Z'));
    expect((await h.service.current(h.customer))?.expiresAt).toBe(first.expiresAt);
    await expect(h.save({}, 10)).rejects.toMatchObject({ status: 409 });
    expect((await h.service.current(h.customer))?.expiresAt).toBe(first.expiresAt);
    const second = await h.save({}, 1);
    expect(second.expiresAt).toBe('2027-01-02T06:00:00.000Z');
    vi.setSystemTime(new Date(second.expiresAt));
    expect(await h.service.current(h.customer)).toBeNull();
    await expect(h.save({}, second.version)).rejects.toMatchObject({ status: 409 });
    const fresh = await h.save();
    expect(fresh.id).not.toBe(second.id); expect(fresh.version).toBe(1);
  });

  it('isolates customers on read/save/delete/submit and rejects staff', async () => {
    const h = fixture(); const a = await h.save();
    expect(await h.service.current(h.other)).toBeNull();
    expect(await h.service.discard(h.other)).toEqual({ deleted: false });
    const b = await h.save({ items: [{}] }, null, h.other);
    expect(b.id).not.toBe(a.id);
    await expect(h.submit(a.id, { expectedVersion: 1, operationKey: randomUUID(), request: h.request }, h.other)).rejects.toMatchObject({ status: 409 });
    expect((await h.service.current(h.customer))?.id).toBe(a.id);
    for (const role of [Role.TECHNICIAN, Role.SERVICE_MANAGER, Role.ADMIN]) {
      const actor = { ...h.customer, role };
      await expect(h.service.current(actor)).rejects.toMatchObject({ status: 403 });
      await expect(h.service.save({ snapshot: {}, expectedVersion: null }, actor)).rejects.toMatchObject({ status: 403 });
      await expect(h.service.discard(actor)).rejects.toMatchObject({ status: 403 });
      await expect(h.service.submit(a.id, { expectedVersion: 1, operationKey: randomUUID(), request: h.request }, actor)).rejects.toMatchObject({ status: 403 });
    }
  });

  it('conflicts instead of overwriting newer explicit saves, including simultaneous creates', async () => {
    const h = fixture();
    const created = await Promise.allSettled([h.save({ customerNote: 'A' }), h.save({ customerNote: 'B' })]);
    expect(created.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(created.filter(r => r.status === 'rejected')).toHaveLength(1);
    await expect(h.save()).rejects.toMatchObject({ status: 409 });
    const saves = await Promise.allSettled([h.save({ customerNote: 'C' }, 1), h.save({ customerNote: 'D' }, 1)]);
    expect(saves.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await h.service.current(h.customer))?.version).toBe(2);
  });

  it('checks address ownership and ignores unavailable upload references without claiming or extending their TTL', async () => {
    const h = fixture(); const uploadId = randomUUID();
    h.uploads.push({ id: uploadId, ownerUserId: h.customer.id, claimedBookingId: null, expiresAt: new Date('2026-11-04T08:00:00Z') });
    await expect(h.save({ addressId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    const saved = await h.save({ addressId: h.addresses[0].id, items: [{ photoUploadIds: [uploadId, randomUUID()] }] });
    expect(saved.snapshot.items?.[0].photoUploadIds).toEqual([uploadId]);
    vi.setSystemTime(new Date('2026-11-04T08:00:00Z'));
    const restored = await h.service.current(h.customer);
    expect(restored?.snapshot.items?.[0].photoUploadIds).toEqual([]);
    expect(restored?.version).toBe(1); expect(restored?.expiresAt).toBe(saved.expiresAt);
    expect(h.uploads[0].claimedBookingId).toBeNull();
    expect(h.uploads[0].expiresAt.toISOString()).toBe('2026-11-04T08:00:00.000Z');
    h.addresses.length = 0;
    expect((await h.service.current(h.customer))?.snapshot.addressId).toBeUndefined();
  });

  it.each(['booking', 'visit_group'])('submits %s with the exact existing create signature and atomically retains separate receipt', async kind => {
    const h = fixture(); const draft = await h.save();
    const request = kind === 'booking' ? h.request : { kind, data: { addressId: h.addresses[0].id,
      mode: 'urgent', items: Array.from({ length: 5 }, () => ({ serviceId: randomUUID() })) } };
    const body: any = { expectedVersion: 1, operationKey: randomUUID(), request };
    const result = await h.submit(draft.id, body);
    expect(h.events.slice(-4)).toEqual(['customer-lock', 'receipt-read', 'draft-lock', 'create']);
    expect(result).toEqual({ kind, bookingId: kind === 'booking' ? h.state().targets[0].id : null,
      visitGroupId: kind === 'visit_group' ? h.state().targets[0].id : null });
    expect(await h.service.current(h.customer)).toBeNull();
    expect(h.state().receipts).toHaveLength(1); expect(h.state().targets).toHaveLength(1);
    expect(h.state().receipts[0]).not.toHaveProperty('request');
  });

  it('replays A after B is saved, even after A expiry, and DELETE B leaves A receipt intact', async () => {
    const h = fixture(); const a = await h.save();
    const body = { expectedVersion: 1, operationKey: randomUUID(), request: h.request };
    const result = await h.submit(a.id, body);
    vi.setSystemTime(new Date('2026-12-05T06:00:00Z'));
    const b = await h.save({ customerNote: 'B' });
    expect(b.id).not.toBe(a.id);
    expect(await h.submit(a.id, body)).toEqual(result);
    expect((await h.service.current(h.customer))?.id).toBe(b.id);
    expect(h.state().targets).toHaveLength(1);
    expect(await h.service.discard(h.customer)).toEqual({ deleted: true });
    expect(await h.submit(a.id, body)).toEqual(result);
    expect(h.state().receipts).toHaveLength(1);
  });

  it('serializes double submit, detects changed fingerprint and rejects another operation on consumed A', async () => {
    const h = fixture(); const draft = await h.save();
    const body = { expectedVersion: 1, operationKey: randomUUID(), request: h.request };
    const [a, b] = await Promise.all([h.submit(draft.id, body), h.submit(draft.id, body)]);
    expect(a).toEqual(b); expect(h.state().targets).toHaveLength(1);
    const reordered = { data: { slot: 'morning', date: '2030-11-05', mode: 'scheduled', quantity: 1,
      serviceId: h.request.data.serviceId, addressId: h.request.data.addressId }, kind: 'booking' };
    expect(await h.submit(draft.id, { ...body, request: reordered })).toEqual(a);
    for (const changed of [{ ...body, expectedVersion: 2 }, { ...body, request: { ...h.request,
      data: { ...h.request.data, customerNote: 'different' } } }, { ...body, operationKey: randomUUID() }]) {
      await expect(h.submit(draft.id, changed)).rejects.toMatchObject({ status: 409 });
    }
  });

  it('rejects stale version or expired submit before create', async () => {
    const h = fixture(); const draft = await h.save();
    const body = { expectedVersion: 2, operationKey: randomUUID(), request: h.request };
    await expect(h.submit(draft.id, body)).rejects.toMatchObject({ status: 409 });
    vi.setSystemTime(new Date(draft.expiresAt));
    await expect(h.submit(draft.id, { ...body, expectedVersion: 1 })).rejects.toMatchObject({ status: 409 });
    expect(h.state().targets).toEqual([]);
  });

  it('serializes PUT/DELETE against submit so a changed/discarded draft cannot create a target', async () => {
    for (const action of ['save', 'discard']) {
      const h = fixture(); const draft = await h.save();
      const body = { expectedVersion: 1, operationKey: randomUUID(), request: h.request };
      const mutation = action === 'save' ? h.save({ customerNote: 'new' }, 1) : h.service.discard(h.customer);
      const results = await Promise.allSettled([mutation, h.submit(draft.id, body)]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
      expect(h.state().targets).toEqual([]);
    }
  });

  it('does not let a group create key reuse another target and fingerprints that key on replay', async () => {
    const h = fixture(); const draft = await h.save();
    const request: any = { kind: 'visit_group', data: { addressId: h.addresses[0].id,
      mode: 'urgent', idempotencyKey: 'previous-group-key', items: [{ serviceId: randomUUID() }] } };
    const body = { expectedVersion: 1, operationKey: randomUUID(), request };
    await h.submit(draft.id, body);
    expect(h.visits.create.mock.calls[0][0]).not.toHaveProperty('idempotencyKey');
    await expect(h.submit(draft.id, { ...body, request: { ...request, data: {
      ...request.data, idempotencyKey: 'changed-group-key',
    } } })).rejects.toMatchObject({ status: 409 });
  });

  it.each(['create', 'receipt'])('rolls back active draft and target on %s failure', async failure => {
    const h = fixture(); const draft = await h.save();
    if (failure === 'create') h.failCreate(); else h.failReceipt();
    await expect(h.submit(draft.id, { expectedVersion: 1, operationKey: randomUUID(), request: h.request })).rejects.toThrow();
    expect(h.state().targets).toEqual([]); expect(h.state().receipts).toEqual([]);
    expect((await h.service.current(h.customer))?.id).toBe(draft.id);
  });
});
