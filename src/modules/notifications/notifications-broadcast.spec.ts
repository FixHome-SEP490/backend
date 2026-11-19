import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { BroadcastNotificationDto } from './dto/broadcast-notification.dto';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';

describe('BUG 176 broadcast notification', () => {
  it('writes every recipient with one INSERT ... SELECT and leaves admins out', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }]);
    const service = new NotificationsService({ query } as never);
    const result = await service.broadcast({ title: 'Bảo trì', message: 'Tối nay 23h', audience: 'all' });
    expect(result).toEqual({ recipients: 3 });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO notifications[\s\S]*SELECT[\s\S]*FROM users/);
    expect(sql).toMatch(/status = 'active'/);
    expect(params).toEqual(['Bảo trì', 'Tối nay 23h', ['customer', 'technician', 'service_manager']]);
  });

  it('targets a single role when an audience is chosen', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const service = new NotificationsService({ query } as never);
    await expect(service.broadcast({ title: 't', message: 'm', audience: 'technician' })).resolves.toEqual({ recipients: 0 });
    expect(query.mock.calls[0][1][2]).toEqual(['technician']);
  });

  it('is admin only and records who sent it', async () => {
    const roles = Reflect.getMetadata(ROLES_KEY, NotificationsController.prototype.broadcast);
    expect(roles).toEqual([Role.ADMIN]);
    const broadcast = vi.fn().mockResolvedValue({ recipients: 5 });
    const log = vi.fn().mockResolvedValue(undefined);
    const controller = new NotificationsController({ broadcast } as never, { log } as never);
    const out = await controller.broadcast(
      Object.assign(new BroadcastNotificationDto(), { title: 'A', message: 'B' }),
      { id: 'admin-1', role: Role.ADMIN } as never,
    );
    expect(out).toEqual({ recipients: 5 });
    expect(broadcast).toHaveBeenCalledWith({ title: 'A', message: 'B', audience: 'all' });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'NOTIFICATION_BROADCAST', actorUserId: 'admin-1' }));
  });

  it.each([
    [{ title: '   ', message: 'x' }],
    [{ title: 'x', message: '' }],
    [{ title: 'x'.repeat(201), message: 'x' }],
    [{ title: 'x', message: 'x'.repeat(2001) }],
    [{ title: 'x', message: 'x', audience: 'admin' }],
  ])('rejects invalid input %j', async (body) => {
    const errors = await validate(plainToInstance(BroadcastNotificationDto, body));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts emoji and Vietnamese text up to the limit', async () => {
    const errors = await validate(plainToInstance(BroadcastNotificationDto, { title: '🔧 Thông báo', message: 'Ưu đãi ✨'.repeat(100), audience: 'customer' }));
    expect(errors).toEqual([]);
  });
});

describe('BUG 176 recall a broadcast', () => {
  const KEY = '2026-11-19 01:10:22.123456+00';

  it('lists broadcasts grouped by their single insert, with read counts', async () => {
    const query = vi.fn().mockResolvedValue([{ key: KEY, title: 'Bảo trì', message: 'm', sent_at: new Date('2026-11-19T01:10:22Z'), recipients: 7, read: 2 }]);
    const service = new NotificationsService({ query } as never);
    const rows = await service.listBroadcasts();
    expect(query.mock.calls[0][0]).toMatch(/type = 'SYSTEM_BROADCAST'[\s\S]*GROUP BY created_at, title, message/);
    expect(rows).toEqual([{ key: KEY, title: 'Bảo trì', message: 'm', sentAt: '2026-11-19T01:10:22.000Z', recipients: 7, read: 2 }]);
  });

  it('reads the count from the [rows, affected] answer PostgreSQL gives a DELETE', async () => {
    const rows = Array.from({ length: 7 }, () => ({ title: 'Kiểm tra' }));
    const query = vi.fn().mockResolvedValue([rows, 7]);
    const service = new NotificationsService({ query } as never);
    await expect(service.recallBroadcast(KEY)).resolves.toEqual({ recalled: 7, title: 'Kiểm tra' });
    query.mockResolvedValue([[], 0]);
    await expect(service.recallBroadcast(KEY)).resolves.toEqual({ recalled: 0, title: null });
  });

  it('deletes only that broadcast, in one query', async () => {
    const query = vi.fn().mockResolvedValue([{ title: 'Bảo trì' }, { title: 'Bảo trì' }]);
    const service = new NotificationsService({ query } as never);
    await expect(service.recallBroadcast(KEY)).resolves.toEqual({ recalled: 2, title: 'Bảo trì' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/DELETE FROM notifications[\s\S]*type = 'SYSTEM_BROADCAST' AND created_at::text = \$1/);
    expect(query.mock.calls[0][1]).toEqual([KEY]);
  });

  it('is admin only, audits the recall and refuses a bad or unknown key', async () => {
    expect(Reflect.getMetadata(ROLES_KEY, NotificationsController.prototype.recallBroadcast)).toEqual([Role.ADMIN]);
    expect(Reflect.getMetadata(ROLES_KEY, NotificationsController.prototype.listBroadcasts)).toEqual([Role.ADMIN]);
    const recallBroadcast = vi.fn().mockResolvedValueOnce({ recalled: 7, title: 'Bảo trì' }).mockResolvedValueOnce({ recalled: 0, title: null });
    const log = vi.fn().mockResolvedValue(undefined);
    const controller = new NotificationsController({ recallBroadcast } as never, { log } as never);
    const admin = { id: 'admin-1', role: Role.ADMIN } as never;
    await expect(controller.recallBroadcast(KEY, admin)).resolves.toEqual({ recalled: 7, title: 'Bảo trì' });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'NOTIFICATION_BROADCAST_RECALLED' }));
    await expect(controller.recallBroadcast(KEY, admin)).rejects.toThrow('đã được thu hồi');
    for (const bad of ["'; DROP TABLE notifications;--", 'abc', '💥', '2026-11-19']) {
      await expect(controller.recallBroadcast(bad, admin)).rejects.toThrow();
    }
    expect(recallBroadcast).toHaveBeenCalledTimes(2);
  });
});
