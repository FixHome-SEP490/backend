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

  async createManyNotifications(
    notifications: Array<{
      userId: string;
      title: string;
      message: string;
      type?: string;
      referenceId?: string;
      referenceType?: string;
    }>,
  ): Promise<Notification[]> {
    if (!notifications.length) return [];
    const entities = notifications.map((params) =>
      this.notificationRepo.create({
        userId: params.userId,
        title: params.title,
        message: params.message,
        type: params.type || 'INFO',
        referenceId: params.referenceId || null,
        referenceType: params.referenceType || null,
        isRead: false,
      }),
    );
    return this.notificationRepo.save(entities);
  }

  /**
   * BUG 176: one INSERT ... SELECT writes the notice for every active account of the audience,
   * so a broadcast costs a single query however many users there are. Admins are left out.
   */
  async broadcast(params: {
    title: string;
    message: string;
    audience: 'all' | 'customer' | 'technician' | 'service_manager';
  }): Promise<{ recipients: number }> {
    const roles = params.audience === 'all' ? ['customer', 'technician', 'service_manager'] : [params.audience];
    const rows: Array<{ id: string }> = await this.notificationRepo.query(
      `INSERT INTO notifications (user_id, title, message, type, is_read)
       SELECT u.id, $1, $2, 'SYSTEM_BROADCAST', false
         FROM users u
        WHERE u.status = 'active' AND u.is_active = true AND u.role::text = ANY($3::text[])
       RETURNING id`,
      [params.title, params.message, roles],
    );
    return { recipients: rows.length };
  }
}
