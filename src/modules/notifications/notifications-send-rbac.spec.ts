import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';
import { NotificationsController } from './notifications.controller';
import { CreateNotificationDto } from './dto/create-notification.dto';

describe('Sending an ad-hoc notification', () => {
  it('is for staff only, never a technician or customer', () => {
    const roles: Role[] = Reflect.getMetadata(
      ROLES_KEY,
      NotificationsController.prototype.sendNotification,
    );
    expect([...roles].sort()).toEqual([Role.ADMIN, Role.SERVICE_MANAGER].sort());
  });

  const base = {
    userId: '11111111-1111-4111-8111-111111111111',
    title: 'Lịch hẹn thay đổi',
    message: 'Kỹ thuật viên sẽ đến lúc 9 giờ.',
  };
  const errorsOf = (body: object) =>
    validate(plainToInstance(CreateNotificationDto, { ...base, ...body })).then((errors) =>
      errors.map((e) => e.property),
    );

  it('accepts an ordinary notification', async () => {
    expect(await errorsOf({})).toEqual([]);
  });

  it('bounds the title, message and type', async () => {
    expect(await errorsOf({ title: 'a'.repeat(201) })).toEqual(['title']);
    expect(await errorsOf({ message: 'a'.repeat(2001) })).toEqual(['message']);
    expect(await errorsOf({ type: 'a'.repeat(51) })).toEqual(['type']);
  });
});
