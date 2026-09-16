import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationsService } from './notifications.service';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mockRepo: any;

  beforeEach(() => {
    mockRepo = {
      findAndCount: vi.fn(),
      count: vi.fn(),
      findOneBy: vi.fn(),
      save: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    };
    service = new NotificationsService(mockRepo);
  });

  it('should return paginated notifications for user', async () => {
    const mockList = [{ id: 'n-1', title: 'Thợ đã nhận đơn', isRead: false }];
    mockRepo.findAndCount.mockResolvedValue([mockList, 1]);

    const result = await service.getMyNotifications('user-1', 1, 10);
    expect(result.data).toEqual(mockList);
    expect(result.total).toBe(1);
    expect(mockRepo.findAndCount).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      order: { createdAt: 'DESC' },
      skip: 0,
      take: 10,
    });
  });

  it('should return unread count for user', async () => {
    mockRepo.count.mockResolvedValue(3);
    const result = await service.getUnreadCount('user-1');
    expect(result.count).toBe(3);
    expect(mockRepo.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', isRead: false },
    });
  });

  it('should mark notification as read if owner', async () => {
    const notif = { id: 'n-1', userId: 'user-1', isRead: false };
    mockRepo.findOneBy.mockResolvedValue(notif);
    mockRepo.save.mockImplementation((n: any) => Promise.resolve(n));

    const result = await service.markAsRead('n-1', 'user-1');
    expect(result.isRead).toBe(true);
  });

  it('should throw NotFoundException if notification does not exist', async () => {
    mockRepo.findOneBy.mockResolvedValue(null);
    await expect(service.markAsRead('n-x', 'user-1')).rejects.toThrow(NotFoundException);
  });

  it('should throw ForbiddenException if user does not own notification', async () => {
    mockRepo.findOneBy.mockResolvedValue({ id: 'n-1', userId: 'user-other' });
    await expect(service.markAsRead('n-1', 'user-1')).rejects.toThrow(ForbiddenException);
  });

  it('should mark all notifications as read for user', async () => {
    mockRepo.update.mockResolvedValue({ affected: 5 });
    const result = await service.markAllAsRead('user-1');
    expect(result.affected).toBe(5);
  });

  it('should create notification properly', async () => {
    const payload = {
      userId: 'user-1',
      title: 'Đơn hoàn tất',
      message: 'Công việc đã được hoàn thành',
      type: 'ORDER_COMPLETED',
      referenceId: 'order-123',
      referenceType: 'SERVICE_ORDER',
    };
    mockRepo.create.mockImplementation((dto: any) => ({ id: 'n-new', ...dto }));
    mockRepo.save.mockImplementation((n: any) => Promise.resolve(n));

    const created = await service.createNotification(payload);
    expect(created.id).toBe('n-new');
    expect(created.isRead).toBe(false);
    expect(created.title).toBe('Đơn hoàn tất');
  });
});
