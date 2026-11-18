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
