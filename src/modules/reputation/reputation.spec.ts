import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AccountStatus, Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { clampPoints, penaltyFor, suspensionEnd } from './reputation-rules';
import { ReputationService } from './reputation.service';

describe('reputation tiers (PO 08/10/2026)', () => {
  it('bans by the score after the change', () => {
    expect(penaltyFor(100)).toEqual({ kind: 'none' });
    expect(penaltyFor(70)).toEqual({ kind: 'none' });
    expect(penaltyFor(60)).toMatchObject({ kind: 'suspend', hours: 72 });
    expect(penaltyFor(40)).toMatchObject({ kind: 'suspend', hours: 72 });
    expect(penaltyFor(30)).toMatchObject({ kind: 'suspend', hours: 7 * 24 });
    expect(penaltyFor(20)).toMatchObject({ kind: 'suspend', hours: 30 * 24 });
    expect(penaltyFor(10)).toMatchObject({ kind: 'suspend', hours: 30 * 24 });
    expect(penaltyFor(0)).toEqual({ kind: 'lock' });
  });

  it('keeps the score between 0 and 100', () => {
    expect(clampPoints(-5)).toBe(0);
    expect(clampPoints(130)).toBe(100);
    expect(clampPoints(55.4)).toBe(55);
  });

  it('never shortens a running ban', () => {
    const now = new Date('2026-10-09T00:00:00Z');
    const later = new Date('2026-12-01T00:00:00Z');
    expect(suspensionEnd(later, 72, now)).toBe(later);
    expect(suspensionEnd(null, 72, now).toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });
});

function setup(user: Partial<User>, options: { replacementCase?: boolean; profile?: Partial<TechnicianProfile> } = {}) {
  const updates: Array<[unknown, unknown, Record<string, unknown>]> = [];
  const saved: Array<Record<string, unknown>> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const profile = { id: 'profile-1', userId: user.id, workSuspendedUntil: null, ...options.profile };
  const manager = {
    query: vi.fn(async () => (options.replacementCase ? [{ '?column?': 1 }] : [])),
    findOne: vi.fn(async (entity: unknown) => (entity === User ? { ...user } : entity === TechnicianProfile ? profile : null)),
    update: vi.fn(async (entity: unknown, where: unknown, values: Record<string, unknown>) => { updates.push([entity, where, values]); }),
    create: vi.fn((_entity: unknown, values: Record<string, unknown>) => values),
    save: vi.fn(async (_entity: unknown, values: Record<string, unknown>) => { saved.push(values); return values; }),
    insert: vi.fn(async (_entity: unknown, values: Record<string, unknown>) => { inserted.push(values); }),
  };
  const config = { getInt: vi.fn(async (_key: string, fallback: number) => fallback) };
  const eventRepo = { save: vi.fn(async (v: unknown) => v), create: vi.fn((v: unknown) => v), find: vi.fn() };
  const dataSource = { transaction: (work: (m: typeof manager) => unknown) => work(manager), query: vi.fn() };
  const service = new ReputationService(eventRepo as never, {} as never, dataSource as never, config as never);
  return { service, manager, updates, saved, inserted, dataSource, eventRepo };
}

const pointsOf = (updates: Array<[unknown, unknown, Record<string, unknown>]>) => updates.find(([e, , v]) => e === User && 'reputationPoints' in v)?.[2].reputationPoints;

describe('ReputationService.penalize', () => {
  it('takes 10 points from a customer who cancels, without a ban above 70', async () => {
    const s = setup({ id: 'c1', role: Role.CUSTOMER, reputationPoints: 100 });
    const event = await s.service.penalize(s.manager as never, { userId: 'c1', role: Role.CUSTOMER, reason: 'Huỷ đơn', serviceOrderId: 'o1', cancellationId: 'x1' });
    expect(pointsOf(s.updates)).toBe(90);
    expect(event).toMatchObject({ kind: 'violation', delta: -10, pointsAfter: 90, penalty: null, serviceOrderId: 'o1', cancellationId: 'x1' });
    expect(s.updates.some(([, , v]) => 'bookingSuspendedUntil' in v)).toBe(false);
    expect(s.inserted[0]).toMatchObject({ userId: 'c1', type: 'REPUTATION_CHANGED' });
  });

  it('bans a customer from booking for 72 hours below 70', async () => {
    const s = setup({ id: 'c1', role: Role.CUSTOMER, reputationPoints: 70 });
    const before = Date.now();
    const event = await s.service.penalize(s.manager as never, { userId: 'c1', role: Role.CUSTOMER, reason: 'Huỷ đơn' });
    const until = s.updates.find(([e, , v]) => e === User && 'bookingSuspendedUntil' in v)?.[2].bookingSuspendedUntil as Date;
    expect(until.getTime() - before).toBeGreaterThanOrEqual(72 * 3600_000 - 1000);
    expect(until.getTime() - before).toBeLessThan(73 * 3600_000);
    expect(event?.penalty).toContain('72 giờ');
  });

  it('suspends a technician\'s work, not booking, for 7 days below 40', async () => {
    const s = setup({ id: 't1', role: Role.TECHNICIAN, reputationPoints: 40 });
    await s.service.penalize(s.manager as never, { userId: 't1', role: Role.TECHNICIAN, reason: 'Huỷ nhận đơn', serviceOrderId: 'o1' });
    const until = s.updates.find(([e]) => e === TechnicianProfile)?.[2].workSuspendedUntil as Date;
    expect(Math.round((until.getTime() - Date.now()) / 3600_000)).toBe(7 * 24);
    expect(s.updates.some(([e, , v]) => e === User && 'bookingSuspendedUntil' in v)).toBe(false);
  });

  it('locks the account for good at 0', async () => {
    const s = setup({ id: 'c1', role: Role.CUSTOMER, reputationPoints: 10 });
    await s.service.penalize(s.manager as never, { userId: 'c1', role: Role.CUSTOMER, reason: 'Huỷ đơn' });
    expect(pointsOf(s.updates)).toBe(0);
    expect(s.updates).toContainEqual([User, 'c1', { status: AccountStatus.LOCKED }]);
  });

  it('spares a technician who reported "Cần thay đổi thợ" on that order', async () => {
    const s = setup({ id: 't1', role: Role.TECHNICIAN, reputationPoints: 100 }, { replacementCase: true });
    const event = await s.service.penalize(s.manager as never, { userId: 't1', role: Role.TECHNICIAN, reason: 'Rút', serviceOrderId: 'o1' });
    expect(event).toBeNull();
    expect(s.updates).toHaveLength(0);
    expect(s.saved).toHaveLength(0);
  });

  it('never touches staff', async () => {
    const s = setup({ id: 'sm', role: Role.SERVICE_MANAGER });
    expect(await s.service.penalize(s.manager as never, { userId: 'sm', role: Role.SERVICE_MANAGER, reason: 'x' })).toBeNull();
    expect(s.manager.findOne).not.toHaveBeenCalled();
  });
});

describe('ReputationService.adjust', () => {
  const staff = { id: 'sm-1', role: Role.SERVICE_MANAGER };

  it('needs a whole non-zero number and a reason', async () => {
    const s = setup({ id: 'c1', role: Role.CUSTOMER, reputationPoints: 50 });
    await expect(s.service.adjust(staff, 'c1', 0, 'lý do đủ dài')).rejects.toThrow('khác 0');
    await expect(s.service.adjust(staff, 'c1', 2.5, 'lý do đủ dài')).rejects.toThrow('khác 0');
    await expect(s.service.adjust(staff, 'c1', 10, '  ab ')).rejects.toThrow('lý do');
    expect(s.updates).toHaveLength(0);
  });

  it('refuses staff accounts', async () => {
    const s = setup({ id: 'a1', role: Role.ADMIN, reputationPoints: 100 });
    await expect(s.service.adjust(staff, 'a1', -10, 'lý do đủ dài')).rejects.toThrow('Không tìm thấy');
  });

  it('raising to 70 or more lifts the ban and records who did it', async () => {
    const s = setup({ id: 'c1', role: Role.CUSTOMER, reputationPoints: 60, bookingSuspendedUntil: new Date('2031-01-01') });
    const result = await s.service.adjust(staff, 'c1', 20, 'Khách huỷ vì thợ đến trễ');
    expect(result.points).toBe(80);
    expect(s.updates).toContainEqual([User, 'c1', { bookingSuspendedUntil: null }]);
    expect(s.saved[0]).toMatchObject({ kind: 'adjustment', delta: 20, pointsAfter: 80, actorUserId: 'sm-1' });
  });

  it('caps at 100 and records the real change', async () => {
    const s = setup({ id: 't1', role: Role.TECHNICIAN, reputationPoints: 95 });
    const result = await s.service.adjust(staff, 't1', 50, 'Trả lại điểm bị trừ nhầm');
    expect(result.points).toBe(100);
    expect(s.saved[0]).toMatchObject({ delta: 5 });
    expect(s.updates).toContainEqual([TechnicianProfile, { userId: 't1' }, { workSuspendedUntil: null }]);
  });

  it('lowering applies the ban of the new score', async () => {
    const s = setup({ id: 't1', role: Role.TECHNICIAN, reputationPoints: 75 });
    await s.service.adjust(staff, 't1', -20, 'Bỏ đơn không báo');
    expect(pointsOf(s.updates)).toBe(55);
    expect(s.updates.some(([e, , v]) => e === TechnicianProfile && v.workSuspendedUntil instanceof Date)).toBe(true);
  });
});

describe('ReputationService.resetSweep', () => {
  it('logs a reset only for users whose score actually moved', async () => {
    const s = setup({});
    s.dataSource.query.mockResolvedValue([{ id: 'c1', before: 60 }, { id: 'c2', before: 100 }]);
    expect(await s.service.resetSweep()).toBe(1);
    expect(s.eventRepo.save).toHaveBeenCalledTimes(1);
    expect(s.eventRepo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'c1', kind: 'reset', delta: 40, pointsAfter: 100 }));
    const [sql, params] = s.dataSource.query.mock.calls[0];
    expect(sql).toContain(`"status" <> 'locked'`);
    expect(params).toEqual([2]);
  });

});
