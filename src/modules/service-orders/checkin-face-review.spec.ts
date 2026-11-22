import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { assertCheckinFaceCleared, recordCheckinFaceOutcome } from './checkin-face-clearance';
import { CheckinFaceReviewService } from './checkin-face-review.service';
import { CheckinFaceReview } from './entities/checkin-face-review.entity';

const ORDER = 'order-1';
const TECH = 'tech-1';

const managerWith = (row: Partial<CheckinFaceReview> | null) => ({ findOne: vi.fn().mockResolvedValue(row) }) as any;

describe('assertCheckinFaceCleared', () => {
  it('lets an order with no review through (older orders, or the rule off)', async () => {
    await expect(assertCheckinFaceCleared(managerWith(null), ORDER, TECH)).resolves.toBeUndefined();
  });

  it('lets an approved face through', async () => {
    await expect(assertCheckinFaceCleared(managerWith({ status: 'approved' }), ORDER, TECH)).resolves.toBeUndefined();
  });

  it('stops a face that waits for a manager, and one that was rejected', async () => {
    await expect(assertCheckinFaceCleared(managerWith({ status: 'pending' }), ORDER, TECH)).rejects.toThrow(/chờ quản lý/);
    await expect(assertCheckinFaceCleared(managerWith({ status: 'rejected' }), ORDER, TECH)).rejects.toThrow(/chụp lại/);
  });
});

describe('recordCheckinFaceOutcome', () => {
  it('writes one row per order of the visit under a single group id', async () => {
    const save = vi.fn();
    const manager = { create: (_: unknown, v: object) => v, save } as any;
    await recordCheckinFaceOutcome(manager, TECH, { similarity: 72, pending: true }, [
      { orderId: 'a', evidenceId: 'ea' }, { orderId: 'b', evidenceId: 'eb' },
    ]);
    const rows = save.mock.calls[0][1];
    expect(rows).toHaveLength(2);
    expect(rows[0].groupId).toBe(rows[1].groupId);
    expect(rows.map((r: CheckinFaceReview) => [r.serviceOrderId, r.status])).toEqual([['a', 'pending'], ['b', 'pending']]);
  });
});

describe('CheckinFaceReviewService.review', () => {
  function make(row: Partial<CheckinFaceReview> | null) {
    const update = vi.fn();
    const manager = { findOne: vi.fn().mockResolvedValue(row), update, findOneBy: vi.fn().mockResolvedValue(null) } as any;
    const dataSource = { transaction: (fn: (m: unknown) => unknown) => fn(manager), manager } as any;
    const notifications = { createNotification: vi.fn() } as any;
    const service = new CheckinFaceReviewService({} as any, {} as any, dataSource, notifications, {} as any, {} as any, {} as any);
    return { service, update, notifications };
  }

  it('asks for a reason when rejecting', async () => {
    const { service, update } = make({ id: 'r', status: 'pending' });
    await expect(service.review('r', 'sm', { approve: false, note: ' ab ' })).rejects.toThrow(/lý do/);
    expect(update).not.toHaveBeenCalled();
  });

  it('approves every pending row of the visit and tells the technician', async () => {
    const { service, update, notifications } = make({ id: 'r', status: 'pending', groupId: 'g', serviceOrderId: ORDER, technicianId: TECH });
    await service.review('r', 'sm', { approve: true });
    expect(update).toHaveBeenCalledWith(CheckinFaceReview, { groupId: 'g', status: 'pending' }, expect.objectContaining({ status: 'approved', reviewedBy: 'sm' }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: TECH, type: 'CHECKIN_FACE_APPROVED' }));
  });

  it('rejects with the reason and does not decide twice', async () => {
    const { service, notifications } = make({ id: 'r', status: 'pending', groupId: 'g', serviceOrderId: ORDER, technicianId: TECH });
    await service.review('r', 'sm', { approve: false, note: 'Không phải kỹ thuật viên' });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'CHECKIN_FACE_REJECTED', message: expect.stringContaining('Không phải kỹ thuật viên') }));
    await expect(make({ id: 'r', status: 'approved' }).service.review('r', 'sm', { approve: true })).rejects.toBeInstanceOf(ConflictException);
  });
});
