import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from '../../shared/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';
import { OrderRealtimeSubscriber } from '../messaging/order-realtime.subscriber';

/** Non-blocking notifications for the warranty flow; a failure never fails the action. */
@Injectable()
export class WarrantyNotifier {
  private readonly logger = new Logger(WarrantyNotifier.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly orderRealtime?: OrderRealtimeSubscriber,
  ) {}

  async toUser(
    userId: string | null | undefined,
    title: string,
    message: string,
    type: string,
    orderId: string,
  ): Promise<void> {
    // Claim decisions are written with plain UPDATEs the realtime subscriber cannot place on an
    // order; the notice that follows each one carries the order, so the order screens and the
    // chat (open again during a claim, PO 18/10/2026) refresh from here.
    void this.orderRealtime?.publish([orderId]);
    if (!userId || !this.notifications) return;
    try {
      await this.notifications.createNotification({
        userId,
        title,
        message,
        type,
        referenceId: orderId,
        referenceType: 'SERVICE_ORDER',
      });
    } catch (error) {
      this.logger.warn(`Warranty notification failed: ${(error as Error).message}`);
    }
  }

  async toManagers(title: string, message: string, type: string, orderId: string): Promise<void> {
    if (!this.notifications) return;
    try {
      const managers = await this.userRepo.find({ where: { role: Role.SERVICE_MANAGER }, select: ['id'] });
      await this.notifications.createManyNotifications(
        managers.map((manager) => ({
          userId: manager.id,
          title,
          message,
          type,
          referenceId: orderId,
          referenceType: 'SERVICE_ORDER',
        })),
      );
    } catch (error) {
      this.logger.warn(`Warranty manager notification failed: ${(error as Error).message}`);
    }
  }
}
