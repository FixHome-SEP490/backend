// src/modules/bookings/bookings.service.ts
import {
  Injectable,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Booking } from './entities/booking.entity';
import { BookingMedia } from './entities/booking-media.entity';
import { User } from '../users/entities/user.entity';
import { Service } from '../services/entities/service.entity';
import { Address } from '../users/entities/address.entity';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { BookingStatus, Role, ServicePricingMode, UrgencyLevel } from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianServiceArea } from '../technicians/entities/technician-service-area.entity';

export { CreateBookingDto } from './booking.dto';
import { CreateBookingDto, RebookDto, validBookingWindow } from './booking.dto';
import { technicianEligibility } from './technician-eligibility';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { InvitationStatus, ServiceOrderStatus } from '../../shared/enums';
import { resolveServiceArea } from '../../shared/utils/administrative-areas';
import { AiDiagnosis } from '../ai-diagnosis/entities/ai-diagnosis.entity';

export interface TechnicianCandidate {
  technicianId: string;
  userId: string;
  fullName: string;
  avatarUrl?: string | null;
  averageRating: number;
  ratingCount: number;
  reliabilityScore: number;
  yearsExperience: number;
  isAvailable: boolean;
  listedLaborPrice?: number | null;
  typicalWarrantyDays?: number;
  hasPriorityBoost?: boolean;
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
    @InjectRepository(BookingMedia)
    private readonly mediaRepo: Repository<BookingMedia>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Service)
    private readonly serviceRepo: Repository<Service>,
    @InjectRepository(Address)
    private readonly addressRepo: Repository<Address>,
    @InjectRepository(TechnicianProfile)
    private readonly techProfileRepo: Repository<TechnicianProfile>,
    @InjectRepository(TechnicianSkill)
    private readonly techSkillRepo: Repository<TechnicianSkill>,
    @InjectRepository(TechnicianServiceArea)
    private readonly techAreaRepo: Repository<TechnicianServiceArea>,
    private readonly auditLogService: AuditLogService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Create a new booking. Validates service, address ownership, and suspension.
   */
  async create(dto: CreateBookingDto, customer: { id: string; role: string }): Promise<Booking> {
    if (customer.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    if (!validBookingWindow(dto.preferredStartAt, dto.preferredEndAt)) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Choose a valid future start and end time');
    if (!dto.addressId || !Number.isInteger(dto.quantity ?? 1) || (dto.quantity ?? 1) < 1) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Address and positive integer quantity required');

    // Check suspension
    const user = await this.userRepo.findOneBy({ id: customer.id });
    if (!user) throw new NotFoundException('User not found');
    if (user.bookingSuspendedUntil && user.bookingSuspendedUntil > new Date()) {
      throw new BusinessException(
        ErrorCodes.BOOKING_SUSPENDED,
        `Account suspended until ${user.bookingSuspendedUntil.toISOString()}`,
        { suspendedUntil: user.bookingSuspendedUntil },
      );
    }

    // Validate service
    const service = await this.serviceRepo.findOneBy({ id: dto.serviceId });
    if (!service || !service.isActive) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Service not found or inactive');
    }

    // Validate address belongs to customer
    if (dto.addressId) {
      const address = await this.addressRepo.findOneBy({
        id: dto.addressId,
        userId: customer.id,
      });
      if (!address) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Address not found');
      }
    }

    const isFixed = service.pricingMode === ServicePricingMode.FIXED_PRICE;
    const quantity = Math.max(1, dto.quantity || 1);

    // Spec v1.4: Validate time window if provided
    if (dto.preferredStartAt && dto.preferredEndAt) {
      const start = new Date(dto.preferredStartAt);
      const end = new Date(dto.preferredEndAt);
      if (start >= end) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          'preferredStartAt must be before preferredEndAt',
        );
      }
    }

    // Spec v1.4: Snapshot address for historical integrity
    let provinceSnapshot: string | null = null;
    let districtSnapshot: string | null = null;
    let provinceNameSnapshot: string | null = null;
    let districtNameSnapshot: string | null = null;
    let addressTextSnapshot: string | null = null;
    let latitudeSnapshot: number | null = null;
    let longitudeSnapshot: number | null = null;
    if (dto.addressId) {
      const address = await this.addressRepo.findOneBy({
        id: dto.addressId,
        userId: customer.id,
      });
      if (address) {
        const resolved = resolveServiceArea({
          province: address.province,
          district: address.district,
          provinceCode: address.provinceCode,
          districtCode: address.districtCode,
        });
        provinceSnapshot = resolved.provinceCode;
        districtSnapshot = resolved.districtCode;
        provinceNameSnapshot = resolved.provinceName;
        districtNameSnapshot = resolved.districtName;
        addressTextSnapshot = [address.line1, address.ward, address.district, address.province]
          .filter(Boolean).join(', ');
        latitudeSnapshot = address.lat != null ? Number(address.lat) : null;
        longitudeSnapshot = address.lng != null ? Number(address.lng) : null;
      }
    }

    if (latitudeSnapshot == null || longitudeSnapshot == null) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Repair address coordinates are required');
    if (isFixed && (service.fixedPrice == null || Number(service.fixedPrice) < 0)) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Service fixed price is not configured');

    const booking = this.bookingRepo.create({
      customerId: customer.id,
      serviceId: dto.serviceId,
      addressId: dto.addressId || null,
      addressTextSnapshot,
      provinceSnapshot,
      districtSnapshot,
      provinceNameSnapshot,
      districtNameSnapshot,
      serviceNameSnapshot: service.name,
      latitudeSnapshot,
      longitudeSnapshot,
      description: dto.description,
      preferredStartAt: dto.preferredStartAt ? new Date(dto.preferredStartAt) : null,
      preferredEndAt: dto.preferredEndAt ? new Date(dto.preferredEndAt) : null,
      pricingModeSnapshot: service.pricingMode,
      fixedUnitPriceSnapshot: isFixed ? service.fixedPrice : null,
      quantity,
      scopeSnapshot: isFixed ? (service.scopeDescription || service.description || null) : null,
      urgency: dto.urgency || UrgencyLevel.MEDIUM,
      status: BookingStatus.SUBMITTED,
    });

    const saved = await this.bookingRepo.save(booking);

    if (dto.mediaUrls && dto.mediaUrls.length > 0) {
      for (const url of dto.mediaUrls) {
        if (!url || typeof url !== 'string') continue;
        const media = this.mediaRepo.create({
          bookingId: saved.id,
          url,
          mimeType: url.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
        });
        await this.mediaRepo.save(media);
      }
    }

    if (dto.aiDiagnosisId) {
      try {
        await this.dataSource.query(
          `UPDATE "ai_diagnoses" SET "booking_id" = $1 WHERE "id" = $2`,
          [saved.id, dto.aiDiagnosisId],
        );
      } catch (err) {
        this.logger.warn(`Failed to link AI diagnosis ${dto.aiDiagnosisId}: ${err.message}`);
      }
    }

    await this.auditLogService.log({
      actorUserId: customer.id,
      actorRole: customer.role,
      action: 'BOOKING_CREATE',
      resourceType: 'booking',
      resourceId: saved.id,
      after: { serviceId: dto.serviceId, urgency: saved.urgency },
    });

    return saved;
  }

  /**
   * Get bookings for a customer with pagination.
   */
  async findMyBookings(
    customerId: string,
    options: { page?: number; limit?: number; status?: BookingStatus },
  ): Promise<{ data: Booking[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.bookingRepo
      .createQueryBuilder('b')
      .where('b.customerId = :customerId', { customerId })
      .leftJoinAndSelect('b.service', 'service')
      .leftJoinAndSelect('b.media', 'media');

    if (options.status) {
      qb.andWhere('b.status = :status', { status: options.status });
    }

    qb.orderBy('b.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  /**
   * Get a booking by ID with ownership check.
   */
  async findById(
    id: string,
    actor: { id: string; role: string },
  ): Promise<Booking> {
    const booking = await this.bookingRepo.findOne({
      where: { id },
      relations: ['service', 'address', 'media', 'invitations'],
    });
    if (!booking) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
    }

    // Ownership check
    if (
      actor.role !== Role.ADMIN &&
      actor.role !== Role.SERVICE_MANAGER &&
      booking.customerId !== actor.id
    ) {
      // Check if actor is an invited technician
      const isInvited = booking.invitations?.some(
        (inv) => inv.technicianId === actor.id,
      );
      if (!isInvited) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
      }
    }

    if (actor.role === Role.TECHNICIAN) {
      booking.invitations = booking.invitations?.filter(invitation => invitation.technicianId === actor.id);
    }
    const order = await this.dataSource.manager.findOneBy(ServiceOrder, { bookingId: id });
    const diagnosis = await this.dataSource.manager.findOne(AiDiagnosis, {
      where: { bookingId: id },
      order: { createdAt: 'DESC' },
    });
    return Object.assign(booking, { serviceOrderId: order?.id, diagnosis });
  }

  async attachMedia(
    bookingId: string,
    body: { url: string; mimeType?: string; sizeBytes?: number },
    actor: { id: string; role: string },
  ): Promise<BookingMedia> {
    const booking = await this.bookingRepo.findOneBy({ id: bookingId });
    if (!booking) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
    }
    if (
      actor.role !== Role.ADMIN &&
      actor.role !== Role.SERVICE_MANAGER &&
      booking.customerId !== actor.id
    ) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
    }
    const media = this.mediaRepo.create({
      bookingId,
      url: body.url,
      mimeType: body.mimeType || (body.url.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'),
      sizeBytes: body.sizeBytes,
    });
    return this.mediaRepo.save(media);
  }

  /**
   * Get technician candidates for a booking.
   * Hard-filter by skill + area, then rank by rating, reliability.
   */
  async getCandidates(
    bookingId: string,
    customer: { id: string },
  ): Promise<TechnicianCandidate[]> {
    const booking = await this.bookingRepo.findOne({
      where: { id: bookingId, customerId: customer.id },
      relations: ['service', 'address'],
    });
    if (!booking) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
    }

    // Find technicians with the matching skill
    const qb = this.techProfileRepo
      .createQueryBuilder('tp')
      .innerJoinAndSelect('tp.user', 'user')
      .innerJoinAndSelect('tp.skills', 'skill', 'skill.serviceId = :serviceId AND skill.isActive = true', {
        serviceId: booking.serviceId,
      })
      .where('tp.isAvailable = :available', { available: true })
      .andWhere('tp.verificationStatus = :verified', { verified: 'verified' })
      .andWhere('(tp.workSuspendedUntil IS NULL OR tp.workSuspendedUntil < :now)', {
        now: new Date(),
      })
      .andWhere('user.status = :active', { active: 'active' });

    // Spec v1.2: Priority Boost as soft ranking signal, followed by rating and reliability
    qb.orderBy(
      'CASE WHEN tp.priorityBoostUntil IS NOT NULL AND tp.priorityBoostUntil > :now THEN 1 ELSE 0 END',
      'DESC',
    )
      .addOrderBy('tp.averageRating', 'DESC')
      .addOrderBy('tp.reliabilityScore', 'DESC');

    const ranked = await qb.getMany();
    const profiles: TechnicianProfile[] = [];
    for (const profile of ranked) {
      if ((await technicianEligibility(this.dataSource.manager, profile.userId, booking)).eligible) {
        profiles.push(profile);
      }
      if (profiles.length === 20) break;
    }

    return profiles.map((tp) => {
      const matchedSkill = tp.skills?.find((s) => s.serviceId === booking.serviceId);
      return {
        technicianId: tp.id,
        userId: tp.userId,
        fullName: tp.user?.fullName || '',
        avatarUrl: tp.user?.avatarUrl || null,
        averageRating: Number(tp.averageRating),
        ratingCount: tp.ratingCount,
        reliabilityScore: tp.reliabilityScore,
        yearsExperience: tp.yearsExperience,
        isAvailable: tp.isAvailable,
        hasPriorityBoost: Boolean(
          tp.priorityBoostUntil && new Date(tp.priorityBoostUntil) > new Date(),
        ),
        listedLaborPrice: matchedSkill?.listedLaborPrice != null ? Number(matchedSkill.listedLaborPrice) : null,
        typicalWarrantyDays: matchedSkill?.typicalWarrantyDays ?? 30,
      };
    });
  }

  /**
   * Reschedule a pending/matching booking.
   */
  async reschedule(
    bookingId: string,
    dto: { preferredStartAt: string; preferredEndAt: string },
    customer: { id: string },
  ): Promise<Booking> {
    if (!validBookingWindow(dto.preferredStartAt, dto.preferredEndAt)) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Choose a valid future time window');
    }
    return this.dataSource.transaction(async (manager) => {
      const booking = await manager.findOne(Booking, {
        where: { id: bookingId, customerId: customer.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking) throw new ForbiddenException('Booking not found');
      if (![BookingStatus.SUBMITTED, BookingStatus.MATCHING, BookingStatus.MATCHED].includes(booking.status)) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Booking cannot be rescheduled');
      }
      const order = await manager.findOne(ServiceOrder, { where: { bookingId }, lock: { mode: 'pessimistic_write' } });
      if (order && ![ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.EN_ROUTE].includes(order.status)) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Repair already started or order closed');
      }
      booking.preferredStartAt = new Date(dto.preferredStartAt);
      booking.preferredEndAt = new Date(dto.preferredEndAt);
      if (order) {
        const assignment = await manager.findOneBy(TechnicianAssignment, { serviceOrderId: order.id, isActive: true });
        if (!assignment) throw new BusinessException(ErrorCodes.CONFLICT, 'No active assignment');
        await manager.findOne(User, { where: { id: assignment.technicianId }, lock: { mode: 'pessimistic_write' } });
        const eligibility = await technicianEligibility(manager, assignment.technicianId, booking, order.id);
        if (!eligibility.eligible) throw new BusinessException(ErrorCodes.CONFLICT, eligibility.reason!);
        await manager.update(ServiceOrder, order.id, { scheduledAt: booking.preferredStartAt });
      } else {
        await manager
          .createQueryBuilder()
          .update(BookingInvitation)
          .set({ status: InvitationStatus.CANCELLED, respondedAt: new Date() })
          .where('booking_id = :bookingId AND status IN (:...statuses)', {
            bookingId,
            statuses: [InvitationStatus.PENDING, InvitationStatus.STANDBY],
          })
          .execute();
        booking.status = BookingStatus.SUBMITTED;
      }
      await this.auditLogService.logWithManager(manager, {
        actorUserId: customer.id,
        actorRole: Role.CUSTOMER,
        action: 'BOOKING_RESCHEDULE',
        resourceType: 'booking',
        resourceId: bookingId,
        after: dto,
      });
      return manager.save(booking);
    });
  }

  async cancelBooking(bookingId: string, reason: string, customer: { id: string }): Promise<Booking> {
    return this.dataSource.transaction(async (manager) => {
      const booking = await manager.findOne(Booking, {
        where: { id: bookingId, customerId: customer.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking) throw new ForbiddenException('Booking not found');
      if (booking.status === BookingStatus.CANCELLED) return booking;
      if (
        ![BookingStatus.SUBMITTED, BookingStatus.MATCHING, BookingStatus.CLOSED].includes(booking.status) ||
        (await manager.findOneBy(ServiceOrder, { bookingId }))
      ) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Cancel the assigned ServiceOrder instead');
      }
      await manager
        .createQueryBuilder()
        .update(BookingInvitation)
        .set({ status: InvitationStatus.CANCELLED, respondedAt: new Date() })
        .where('booking_id = :bookingId AND status IN (:...statuses)', {
          bookingId,
          statuses: [InvitationStatus.PENDING, InvitationStatus.STANDBY],
        })
        .execute();
      booking.status = BookingStatus.CANCELLED;
      await this.auditLogService.logWithManager(manager, {
        actorUserId: customer.id,
        actorRole: Role.CUSTOMER,
        action: 'BOOKING_CANCEL',
        resourceType: 'booking',
        resourceId: bookingId,
        after: { reason },
      });
      return manager.save(booking);
    });
  }

  async rebook(oldBookingId: string, customer: { id: string; role: string }, dto: RebookDto): Promise<Booking> {
    const old = await this.bookingRepo.findOneBy({ id: oldBookingId, customerId: customer.id });
    if (!old) throw new ForbiddenException('Booking not found');
    return this.create(
      {
        serviceId: old.serviceId,
        addressId: old.addressId!,
        description: dto.problemDescription?.trim() || old.description,
        preferredStartAt: dto.preferredStartAt,
        preferredEndAt: dto.preferredEndAt,
        quantity: dto.quantity ?? old.quantity,
        urgency: old.urgency,
      },
      customer,
    );
  }
}
