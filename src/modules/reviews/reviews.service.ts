// src/modules/reviews/reviews.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import { Review } from './entities/review.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { User } from '../users/entities/user.entity';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { ServiceOrderStatus, Role } from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';

import { CreateReviewDto } from './review.dto';
export { CreateReviewDto } from './review.dto';
import { authorizeOrder } from '../service-orders/order-access';

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    @InjectRepository(Review)
    private readonly reviewRepo: Repository<Review>,
    @InjectRepository(ServiceOrder)
    private readonly orderRepo: Repository<ServiceOrder>,
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
    @InjectRepository(TechnicianAssignment)
    private readonly assignmentRepo: Repository<TechnicianAssignment>,
    @InjectRepository(TechnicianProfile)
    private readonly techProfileRepo: Repository<TechnicianProfile>,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Create review for completed service order.
   * D-09: One review per service order (enforced at DB level uq_review_order).
   */
  async createReview(
    orderId: string,
    dto: CreateReviewDto,
    customerUser: { id: string; role: string },
  ): Promise<Review> {
    if (!Number.isInteger(dto.rating) || dto.rating < 1 || dto.rating > 5) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Rating must be between 1 and 5',
      );
    }

    const order = await this.orderRepo.findOneBy({ id: orderId });
    if (!order) {
      throw new NotFoundException(`Service order ${orderId} not found`);
    }

    if (order.status !== ServiceOrderStatus.COMPLETED) {
      throw new BusinessException(
        ErrorCodes.ORDER_INVALID_TRANSITION,
        'Only COMPLETED orders can be reviewed',
      );
    }

    // Verify customer owns the order
    const booking = await this.bookingRepo.findOneBy({ id: order.bookingId });
    if (
      !booking ||
      (booking.customerId !== customerUser.id || customerUser.role !== Role.CUSTOMER)
    ) {
      throw new BusinessException(
        ErrorCodes.OWNERSHIP_DENIED,
        'Only the customer of this order can submit a review',
      );
    }

    // Check for existing review
    const existing = await this.reviewRepo.findOneBy({ serviceOrderId: orderId });
    if (existing) {
      throw new BusinessException(
        ErrorCodes.CONFLICT,
        'Bạn đã đánh giá đơn này rồi.',
      );
    }

    // Find technician who serviced the order
    const assignment = await this.assignmentRepo.findOne({
      where: { serviceOrderId: orderId },
      order: { assignedAt: 'DESC' },
    });
    if (!assignment) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'No technician found for this order',
      );
    }

    const technicianId = assignment.technicianId;

    const result = await this.dataSource.transaction(async (manager) => {
      await authorizeOrder(manager, orderId, customerUser, 'customer', true);
      await manager.findOne(TechnicianProfile, { where: { userId: technicianId }, lock: { mode: 'pessimistic_write' } });
      if (await manager.findOneBy(Review, { serviceOrderId: orderId })) throw new BusinessException(ErrorCodes.CONFLICT, 'Review already exists');
      const review = manager.create(Review, {
        serviceOrderId: orderId,
        customerId: customerUser.id,
        technicianId,
        rating: Math.round(dto.rating),
        comment: dto.comment || null,
        isModerated: false,
      });

      const savedReview = await manager.save(review);

      // Recalculate technician rating
      const reviews = await manager.find(Review, {
        where: { technicianId },
      });

      const count = reviews.length;
      const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
      const avg = count > 0 ? parseFloat((sum / count).toFixed(2)) : 0;

      const profile = await manager.findOne(TechnicianProfile, {
        where: { userId: technicianId },
      });
      if (profile) {
        profile.averageRating = avg;
        profile.ratingCount = count;
        await manager.save(profile);
      }

      await this.auditLogService.logWithManager(manager, {
        actorUserId: customerUser.id,
        actorRole: customerUser.role,
        action: 'REVIEW_SUBMITTED',
        resourceType: 'review',
        resourceId: savedReview.id,
        after: { orderId, technicianId, rating: dto.rating },
      });

      return savedReview;
    });

    try {
      await this.notificationsService.createNotification({
        userId: technicianId,
        title: 'Đánh giá mới từ khách hàng',
        message: `Khách hàng vừa đánh giá bạn ${Math.round(dto.rating)}/5 sao cho đơn sửa chữa ${order.code || ''}.`,
        type: 'REVIEW',
        referenceId: result.id,
        referenceType: 'review',
      });
    } catch (notifErr) {
      this.logger.warn(`Failed to dispatch review notification to technician ${technicianId}: ${(notifErr as Error).message}`);
    }

    return result;
  }

  async findByOrderId(orderId: string, actor: { id: string; role: string }): Promise<Review | null> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.reviewRepo.findOneBy({ serviceOrderId: orderId });
  }

  async findByTechnicianId(
    technicianId: string,
    options: { page?: number; limit?: number },
  ): Promise<{ data: Array<Review & { customerName?: string }>; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const [data, total] = await this.reviewRepo.findAndCount({
      where: { technicianId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const customerIds = [...new Set(data.map((r) => r.customerId).filter(Boolean))];
    const customers = customerIds.length
      ? await this.dataSource.getRepository(User).findBy({ id: In(customerIds) })
      : [];
    const customerMap = new Map(customers.map((c) => [c.id, c.fullName]));

    const enriched = data.map((r) => ({
      ...r,
      customerName: customerMap.get(r.customerId) || 'Khách hàng FixHome',
    }));

    return { data: enriched, total };
  }
}
