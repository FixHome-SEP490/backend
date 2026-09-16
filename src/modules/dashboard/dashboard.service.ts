// src/modules/dashboard/dashboard.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { BookingInvitation } from '../bookings/entities/booking-invitation.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { Cancellation } from '../service-orders/entities/cancellation.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import {
  BookingStatus,
  ServiceOrderStatus,
  InvitationStatus,
  PaymentStatus,
} from '../../shared/enums';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
    @InjectRepository(ServiceOrder)
    private readonly orderRepo: Repository<ServiceOrder>,
    @InjectRepository(BookingInvitation)
    private readonly invitationRepo: Repository<BookingInvitation>,
    @InjectRepository(TechnicianAssignment)
    private readonly assignmentRepo: Repository<TechnicianAssignment>,
    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(Cancellation)
    private readonly cancellationRepo: Repository<Cancellation>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(TechnicianProfile)
    private readonly profileRepo: Repository<TechnicianProfile>,
  ) {}

  /**
   * Customer dashboard: active bookings, recent orders, total spent.
   */
  async getCustomerDashboard(userId: string) {
    const activeBookings = await this.bookingRepo.count({
      where: [
        { customerId: userId, status: BookingStatus.SUBMITTED },
        { customerId: userId, status: BookingStatus.MATCHING },
      ],
    });

    const recentBookings = await this.bookingRepo.find({
      where: { customerId: userId },
      order: { createdAt: 'DESC' },
      take: 5,
    });

    // Recent orders
    const orders = await this.orderRepo
      .createQueryBuilder('o')
      .innerJoin('bookings', 'b', 'b.id = o.booking_id')
      .where('b.customer_id = :userId', { userId })
      .orderBy('o.createdAt', 'DESC')
      .take(5)
      .getMany();

    const activeOrdersCount = await this.orderRepo
      .createQueryBuilder('o')
      .innerJoin('bookings', 'b', 'b.id = o.booking_id')
      .where('b.customer_id = :userId', { userId })
      .andWhere('o.status IN (:...statuses)', {
        statuses: [
          ServiceOrderStatus.ACCEPTED,
          ServiceOrderStatus.EN_ROUTE,
          ServiceOrderStatus.UNDER_REPAIR,
        ],
      })
      .getCount();

    return {
      activeBookings,
      activeOrdersCount,
      recentBookings,
      recentOrders: orders,
    };
  }

  /**
   * Technician dashboard: pending invitations, active orders, today's schedule, real metrics.
   */
  async getTechnicianDashboard(userId: string) {
    const pendingInvitations = await this.invitationRepo.count({
      where: {
        technicianId: userId,
        status: InvitationStatus.PENDING,
      },
    });

    const activeAssignments = await this.assignmentRepo
      .createQueryBuilder('ta')
      .innerJoinAndSelect('service_orders', 'so', 'so.id = ta.service_order_id')
      .leftJoinAndSelect('bookings', 'b', 'b.id = so.booking_id')
      .leftJoinAndSelect('users', 'c', 'c.id = b.customer_id')
      .where('ta.technician_id = :userId', { userId })
      .andWhere('ta.is_active = true')
      .andWhere('so.status IN (:...statuses)', {
        statuses: [
          ServiceOrderStatus.ACCEPTED,
          ServiceOrderStatus.EN_ROUTE,
          ServiceOrderStatus.UNDER_REPAIR,
        ],
      })
      .orderBy('so.created_at', 'DESC')
      .getRawMany();

    const profile = await this.profileRepo.findOne({
      where: { userId },
      relations: ['serviceAreas'],
    });

    const completedOrders = await this.assignmentRepo
      .createQueryBuilder('ta')
      .innerJoinAndSelect('service_orders', 'so', 'so.id = ta.service_order_id')
      .where('ta.technician_id = :userId', { userId })
      .andWhere('so.status = :status', { status: ServiceOrderStatus.COMPLETED })
      .getRawMany();

    const completedOrdersCount = completedOrders.length;
    let monthlyEarnings = 0;
    for (const row of completedOrders) {
      const gross = Number(row.so_labor_total || row.so_grand_total || 0);
      monthlyEarnings += Math.round(gross * 0.9);
    }

    const latestInvitation = await this.invitationRepo.findOne({
      where: {
        technicianId: userId,
        status: InvitationStatus.PENDING,
      },
      relations: ['booking'],
      order: { createdAt: 'DESC' },
    });

    let activeJob: any = null;
    if (activeAssignments.length > 0) {
      const first = activeAssignments[0];
      activeJob = {
        id: first.so_id,
        orderCode: first.so_code || `#ORD-${String(first.so_id).slice(0, 8)}`,
        status: first.so_status,
        serviceTitle: first.b_service_name_snapshot || first.b_description || 'Dịch vụ sửa chữa FixHome',
        customerName: first.c_full_name || 'Khách hàng FixHome',
        customerPhone: first.c_phone_number || '',
        address: first.b_address_text_snapshot || 'Địa chỉ khách hàng',
        createdAt: first.so_created_at,
      };
    }

    let invitationDetail: any = null;
    if (latestInvitation && latestInvitation.booking) {
      const b = latestInvitation.booking;
      invitationDetail = {
        id: latestInvitation.id,
        bookingId: b.id,
        serviceTitle: b.serviceNameSnapshot || b.description || 'Yêu cầu sửa chữa',
        address: b.addressTextSnapshot || 'TP. Hồ Chí Minh',
        preferredStartAt: b.preferredStartAt,
        preferredEndAt: b.preferredEndAt,
        expiresAt: latestInvitation.expiresAt,
        estimatedTotal: Number(b.fixedUnitPriceSnapshot || 0) * (b.quantity || 1),
      };
    }

    return {
      pendingInvitations,
      activeOrdersCount: activeAssignments.length,
      completedOrdersCount,
      rating: Number(profile?.averageRating) || 5.0,
      ratingCount: profile?.ratingCount || 0,
      reliabilityScore: profile?.reliabilityScore || 100,
      monthlyEarnings,
      activeJob,
      latestInvitation: invitationDetail,
      serviceAreas: profile?.serviceAreas || [],
      isAvailable: profile?.isAvailable ?? true,
    };
  }

  /**
   * Operations dashboard (Service Manager):
   * Summary of all orders by status, unassigned bookings, pending cancellations.
   */
  async getOperationalDashboard() {
    const ordersByStatus = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('o.status')
      .getRawMany();

    const pendingCancellations = await this.cancellationRepo.count({
      where: { reviewedByUserId: null as any },
    });

    const activeOrders = await this.orderRepo.count({
      where: [
        { status: ServiceOrderStatus.ACCEPTED },
        { status: ServiceOrderStatus.EN_ROUTE },
        { status: ServiceOrderStatus.UNDER_REPAIR },
      ],
    });

    const matchingBookings = await this.bookingRepo.count({
      where: [
        { status: BookingStatus.SUBMITTED },
        { status: BookingStatus.MATCHING },
      ],
    });

    return {
      ordersByStatus,
      activeOrders,
      matchingBookings,
      pendingCancellations,
    };
  }

  /**
   * System dashboard (Admin):
   * Total users by role, revenue, platform health metrics.
   */
  async getSystemDashboard() {
    const usersByRole = await this.userRepo
      .createQueryBuilder('u')
      .select('u.role', 'role')
      .addSelect('COUNT(*)', 'count')
      .groupBy('u.role')
      .getRawMany();

    const totalOrders = await this.orderRepo.count();
    const completedOrders = await this.orderRepo.count({
      where: { status: ServiceOrderStatus.COMPLETED },
    });

    const revenueResult = await this.invoiceRepo
      .createQueryBuilder('i')
      .select('SUM(i.grand_total)', 'totalRevenue')
      .addSelect('SUM(i.commission_amount)', 'totalCommission')
      .where('i.payment_status = :status', { status: PaymentStatus.PAID })
      .getRawOne();

    return {
      usersByRole,
      totalOrders,
      completedOrders,
      totalRevenue: Number(revenueResult?.totalRevenue || 0),
      totalCommission: Number(revenueResult?.totalCommission || 0),
    };
  }
}
