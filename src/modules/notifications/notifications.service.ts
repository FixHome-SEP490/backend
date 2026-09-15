// src/modules/notifications/notifications.service.ts
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
  ) {}

  async getMyNotifications(userId: string, page = 1, limit = 20): Promise<{ data: Notification[]; total: number }> {
    const [data, total] = await this.notificationRepo.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total };
  }

  async getUnreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.notificationRepo.count({
      where: { userId, isRead: false },
    });
    return { count };
  }

  async markAsRead(id: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepo.findOneBy({ id });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.userId !== userId) throw new ForbiddenException('Access denied');
    notification.isRead = true;
    return this.notificationRepo.save(notification);
  }

  async markAllAsRead(userId: string): Promise<{ affected: number }> {
    const result = await this.notificationRepo.update({ userId, isRead: false }, { isRead: true });
    return { affected: result.affected ?? 0 };
  }

  async createNotification(params: {
    userId: string;
    title: string;
    message: string;
    type?: string;
    referenceId?: string;
    referenceType?: string;
  }): Promise<Notification> {
    const notif = this.notificationRepo.create({
      userId: params.userId,
      title: params.title,
      message: params.message,
      type: params.type || 'INFO',
      referenceId: params.referenceId || null,
      referenceType: params.referenceType || null,
      isRead: false,
    });
    return this.notificationRepo.save(notif);
  }
}
