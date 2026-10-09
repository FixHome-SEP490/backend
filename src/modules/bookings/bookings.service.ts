// src/modules/bookings/bookings.service.ts
import { firstEligible } from './first-eligible';
import { displayRating } from '../technicians/technician-earnings';
import { NotificationsService } from '../notifications/notifications.service';
import {
  Injectable,
  ForbiddenException,
  Logger,
  NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, In } from 'typeorm';
import { isUUID } from 'class-validator';
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

export { CreateBookingDto } from './booking.dto';
import { AttachBookingMediaDto, CreateBookingDto, RebookDto, ScheduleBookingDto } from './booking.dto';
import { BOOKING_SLOTS, resolveBookingWindow, slotWindow, vnDate, type BookingSlot } from './booking-slots';
import { distanceToBooking, servesArea, technicianOrigin } from './technician-location';
import { TechnicianServiceArea } from '../technicians/entities/technician-service-area.entity';
import { technicianEligibility } from './technician-eligibility';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { InvitationStatus, ServiceOrderStatus } from '../../shared/enums';
import { resolveServiceArea } from '../../shared/utils/administrative-areas';
import { AiDiagnosis } from '../ai-diagnosis/entities/ai-diagnosis.entity';
import { BusinessConfigService } from '../system-config/business-config.service';
import {
  isLegacyPublicBookingMediaUrl,
  TechnicianBookingPreviewDto,
  toTechnicianBookingPreview,
} from './booking-privacy.dto';
import { PrivateBookingPhotoClaimService } from '../media/private-booking-photo-claim.service';
import { AiChatSession } from '../ai-diagnosis/entities/ai-chat-session.entity';
import { AiBookingSummary, hasAdvice, toBookingSummary } from '../ai-diagnosis/ai-chat-summary';

export interface TechnicianCandidate {
  technicianId: string;
  userId: string;
  fullName: string;
  avatarUrl?: string | null;
  averageRating: number | null;
  ratingCount: number;
  reliabilityScore: number;
  yearsExperience: number;
  isAvailable: boolean;
  listedLaborPrice?: number | null;
  typicalWarrantyDays?: number;
  hasPriorityBoost?: boolean;
  distanceKm?: number | null;
  bio?: string | null;
  completedOrdersCount?: number;
  completionRate?: number;
}

/** At most this many technicians are offered for one booking. */
const CANDIDATE_LIMIT = 20;
/** Technicians whose eligibility is checked at once; stays under the database pool. */
const ELIGIBILITY_BATCH = 8;

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
    private readonly auditLogService: AuditLogService,
    private readonly dataSource: DataSource,
    private readonly privateBookingPhotoClaimService: PrivateBookingPhotoClaimService,
    private readonly configService: BusinessConfigService,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  /**
   * Summary of the assistant conversation this booking comes from. A session
   * held by another customer, or one that found nothing, gives none. Never
   * fails the booking: the assistant is advisory and its absence is normal.
   */
  private async aiSummaryFor(sessionId: string, customerId: string): Promise<AiBookingSummary | null> {
    try {
      const session = await this.dataSource.getRepository(AiChatSession).findOneBy({ sessionId });
      if (!session || (session.customerId && session.customerId !== customerId)) return null;
      return hasAdvice(session.summary) ? toBookingSummary(session.summary) : null;
    } catch (err) {
      this.logger.warn(`AI session summary unavailable for booking: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Create a new booking. Validates service, address ownership, and suspension.
   */
  async create(dto: CreateBookingDto, customer: { id: string; role: string }): Promise<Booking> {
    if (customer.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    this.validateCreateMediaInput(dto);
    const urgentMinutes = dto.mode === 'urgent' ? await this.configService.getInt('booking.urgent_window_minutes', 120) : 0;
    const window = resolveBookingWindow(dto, new Date(), urgentMinutes);
    if ('error' in window) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, window.error);
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

    const aiSummary = dto.aiSessionId ? await this.aiSummaryFor(dto.aiSessionId, customer.id) : null;

    const saved = await this.dataSource.transaction(async (manager) => {
      const bookingRepository = manager.getRepository(Booking);
      const mediaRepository = manager.getRepository(BookingMedia);
      const booking = bookingRepository.create({
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
        preferredStartAt: window.start,
        preferredEndAt: window.end,
        bookingMode: window.mode,
        slot: window.slot,
        customerNote: dto.customerNote?.trim() || null,
        pricingModeSnapshot: service.pricingMode,
        fixedUnitPriceSnapshot: isFixed ? service.fixedPrice : null,
        quantity,
        scopeSnapshot: isFixed ? (service.scopeDescription || service.description || null) : null,
        urgency: dto.urgency || UrgencyLevel.MEDIUM,
        status: BookingStatus.SUBMITTED,
        aiSummary,
      });
      const created = await bookingRepository.save(booking);
      let media: BookingMedia[] = [];

      if (dto.photoUploadIds?.length) {
        const claimed = await this.privateBookingPhotoClaimService.claim(
          manager,
          customer.id,
          created.id,
          dto.photoUploadIds,
        );
        media = await mediaRepository.save(claimed.map((upload) => mediaRepository.create({
          bookingId: created.id,
          privateUploadId: upload.uploadId,
          url: '',
          mimeType: upload.mimeType,
          sizeBytes: upload.sizeBytes,
        })));
      } else if (dto.mediaUrls?.length) {
        media = await mediaRepository.save(dto.mediaUrls.map((url) => mediaRepository.create({
          bookingId: created.id,
          privateUploadId: null,
          url,
          mimeType: url.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
        })));
      }

      if (media.length > 0) Object.assign(created, { media });
      return created;
    });

    if (dto.aiDiagnosisId) {
      try {
        await this.dataSource.query(
          `UPDATE "ai_diagnoses" AS diagnosis SET "booking_id" = $1 FROM "bookings" AS source WHERE diagnosis."id" = $2 AND diagnosis."booking_id" = source."id" AND source."customer_id" = $3 RETURNING diagnosis."id"`,
          [saved.id, dto.aiDiagnosisId, customer.id],
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

  private validateCreateMediaInput(dto: CreateBookingDto): void {
    if (dto.photoUploadIds !== undefined && dto.mediaUrls !== undefined) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Use one Booking photo source at a time',
      );
    }

    if (dto.photoUploadIds !== undefined) {
      const ids = dto.photoUploadIds;
      if (
        !Array.isArray(ids) ||
        ids.length > 5 ||
        ids.some((id) => typeof id !== 'string' || !isUUID(id)) ||
        new Set(ids.map((id) => id.toLowerCase())).size !== ids.length
      ) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          'Provide at most five distinct valid Booking photo upload IDs',
        );
      }
    }

    if (
      dto.mediaUrls !== undefined &&
      (!Array.isArray(dto.mediaUrls) || dto.mediaUrls.some((url) => !isLegacyPublicBookingMediaUrl(url)))
    ) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Only absolute HTTP(S) legacy public media URLs are accepted',
      );
    }
  }

  /** Lazy expiry (same pattern as invitation matching): customer's requested window has passed with no technician engaged. */
  private async closeOverdueBookings(): Promise<void> {
    await this.bookingRepo
      .createQueryBuilder()
      .update(Booking)
      .set({ status: BookingStatus.CLOSED })
      .where('status IN (:...statuses)', { statuses: [BookingStatus.SUBMITTED, BookingStatus.MATCHING] })
      .andWhere('preferred_end_at IS NOT NULL AND preferred_end_at <= :now', { now: new Date() })
      .execute();
  }

  /**
   * Get bookings for a customer with pagination.
   */
  async findMyBookings(
    customerId: string,
    options: { page?: number; limit?: number; status?: BookingStatus },
  ): Promise<{ data: Booking[]; total: number }> {
    await this.closeOverdueBookings();
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
   * SM/Admin board: list all bookings (no customer restriction).
   * Used to find bookings stuck in MATCHING for manual assignment.
   */
  async findAllForStaff(
    options: { page?: number; limit?: number; status?: BookingStatus },
  ): Promise<{ data: Booking[]; total: number }> {
    await this.closeOverdueBookings();
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.bookingRepo
      .createQueryBuilder('b')
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
  ): Promise<Booking | TechnicianBookingPreviewDto> {
    await this.closeOverdueBookings();
    const booking = await this.bookingRepo.findOne({
      where: { id },
      relations: ['invitations'],
    });
    if (!booking) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
    }

    if (actor.role === Role.ADMIN || actor.role === Role.SERVICE_MANAGER) {
      return this.findFullBooking(id);
    }

    if (actor.role === Role.CUSTOMER && booking.customerId === actor.id) {
      return this.findFullBooking(id);
    }

    if (actor.role !== Role.TECHNICIAN) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
    }

    // Keep the authorization check and private read under the same locks.
    // Matching/withdrawal commands lock Booking first; lock the order too so
    // expiry/cancellation cannot remove the assignment during this response.
    return this.dataSource.transaction(async manager => {
      const current = await manager.findOne(Booking, {
        where: { id }, lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
      const invitations = await manager.find(BookingInvitation, { where: { bookingId: id } });
      const hasLiveInvitation = invitations.some(
        item => item.technicianId === actor.id &&
          item.status === InvitationStatus.PENDING &&
          item.expiresAt != null && item.expiresAt > new Date(),
      );
      if (current.status === BookingStatus.MATCHING && hasLiveInvitation) {
        return toTechnicianBookingPreview(current);
      }
      // The active assignment below is what proves the technician holds the
      // job; an accepted invitation is not required, because a technician
      // assigned by staff never had one.
      if (current.status !== BookingStatus.MATCHED) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
      }
      const order = await manager.findOne(ServiceOrder, {
        where: { bookingId: id }, lock: { mode: 'pessimistic_write' },
      });
      if (!order || order.status === ServiceOrderStatus.CANCELLED ||
          !await manager.findOneBy(TechnicianAssignment, {
            serviceOrderId: order.id, technicianId: actor.id, isActive: true,
          })) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
      }
      const fullBooking = await manager.findOne(Booking, {
        where: { id }, relations: ['service', 'address', 'media', 'invitations'],
      });
      if (!fullBooking || fullBooking.status !== BookingStatus.MATCHED) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
      }
      fullBooking.invitations = (fullBooking.invitations ?? []).filter(item => item.technicianId === actor.id);
      return this.addBookingReadDetails(fullBooking, order, manager);
    });
  }
  private async findFullBooking(id: string): Promise<Booking> {
    const booking = await this.bookingRepo.findOne({
      where: { id },
      relations: ['service', 'address', 'media', 'invitations'],
    });
    if (!booking) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
    }
    const order = await this.dataSource.manager.findOneBy(ServiceOrder, { bookingId: id });
    return this.addBookingReadDetails(booking, order);
  }

  private async addBookingReadDetails(
    booking: Booking,
    order: ServiceOrder | null,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Booking> {
    const diagnosis = await manager.findOne(AiDiagnosis, {
      where: { bookingId: booking.id },
      order: { createdAt: 'DESC' },
    });
    return Object.assign(booking, { serviceOrderId: order?.id, diagnosis });
  }

  async attachMedia(
    bookingId: string,
    body: AttachBookingMediaDto,
    actor: { id: string; role: string },
  ): Promise<BookingMedia> {
    if (!isLegacyPublicBookingMediaUrl(body?.url)) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Only absolute HTTP(S) legacy public media URLs are accepted',
      );
    }
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
      privateUploadId: null,
      mimeType: body.mimeType || (body.url.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'),
      sizeBytes: body.sizeBytes,
    });
    return this.mediaRepo.save(media);
  }

  /**
   * Get technician candidates for a booking.
   * Hard-filter by skill + technician's own service radius, then rank by distance, rating, reliability.
   */
  async getCandidates(
    bookingId: string,
    actor: { id: string; role?: string },
  ): Promise<TechnicianCandidate[]> {
    const isStaff = actor.role === Role.ADMIN || actor.role === Role.SERVICE_MANAGER;
    const booking = await this.bookingRepo.findOne({
      where: isStaff ? { id: bookingId } : { id: bookingId, customerId: actor.id },
      relations: ['service', 'address'],
    });
    if (!booking) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
    }

    // Find technicians with the matching skill; the location/radius hard-filter below decides who's shown.
    const qb = this.techProfileRepo
      .createQueryBuilder('tp')
      .innerJoinAndSelect('tp.user', 'user')
      .innerJoinAndSelect(
        'tp.skills',
        'skill',
        'skill.serviceId = :serviceId AND skill.isActive = true AND skill.verificationStatus = :skillVerified',
        {
          serviceId: booking.serviceId,
          skillVerified: 'verified',
        },
      )
      .where('tp.isAvailable = :available', { available: true })
      .andWhere('tp.verificationStatus = :verified', { verified: 'verified' })
      .andWhere('(tp.workSuspendedUntil IS NULL OR tp.workSuspendedUntil < :now)', {
        now: new Date(),
      })
      .andWhere('user.status = :active', { active: 'active' });

    const withSkill = await qb.getMany();

    // Location pre-filter, same rule as technicianEligibility() (which stays the final
    // authority): an urgent booking measures from a fresh GPS position when there is one,
    // otherwise from the work address, and then the technician must also serve the
    // booking's district if they chose service areas. Missing coordinates never match.
    // ponytail: in-memory scan of every skilled technician; move to SQL/PostGIS if it grows.
    const userIds = withSkill.map((tp) => tp.userId);
    const workAddresses = userIds.length
      ? await this.addressRepo.find({ where: { userId: In(userIds), isDefault: true } })
      : [];
    const addressByUserId = new Map(workAddresses.map((a) => [a.userId, a]));
    const profileIds = withSkill.map((tp) => tp.id);
    const allAreas = profileIds.length
      ? await this.dataSource.manager.find(TechnicianServiceArea, { where: { technicianId: In(profileIds) } })
      : [];
    const areasByProfile = new Map<string, TechnicianServiceArea[]>();
    for (const area of allAreas) areasByProfile.set(area.technicianId, [...(areasByProfile.get(area.technicianId) ?? []), area]);
    const mode = booking.bookingMode === 'urgent' ? 'urgent' : 'scheduled';
    const gpsFreshMinutes = await this.configService.getInt('matching.gps_fresh_minutes', 15);
    const distanceByProfileId = new Map<string, number | null>();
    const ranked = withSkill.filter((tp) => {
      const origin = technicianOrigin(mode, tp, addressByUserId.get(tp.userId), gpsFreshMinutes);
      if (!origin) return false;
      if (origin.source === 'address' && !servesArea(areasByProfile.get(tp.id) ?? [], booking)) return false;
      const distance = distanceToBooking(origin, booking);
      if (distance == null || distance > Number(tp.serviceRadiusKm)) return false;
      distanceByProfileId.set(tp.id, distance);
      return true;
    });

    // Spec v1.2: Priority Boost first, then nearest distance, then rating and reliability
    const now = new Date();
    ranked.sort((a, b) => {
      const boostA = a.priorityBoostUntil && new Date(a.priorityBoostUntil) > now ? 1 : 0;
      const boostB = b.priorityBoostUntil && new Date(b.priorityBoostUntil) > now ? 1 : 0;
      if (boostA !== boostB) return boostB - boostA;
      const distA = distanceByProfileId.get(a.id);
      const distB = distanceByProfileId.get(b.id);
      if (distA != null || distB != null) {
        if (distA == null) return 1;
        if (distB == null) return -1;
        if (distA !== distB) return distA - distB;
      }
      const ratingA = displayRating(a.averageRating, a.ratingCount) ?? 0;
      const ratingB = displayRating(b.averageRating, b.ratingCount) ?? 0;
      if (ratingA !== ratingB) return ratingB - ratingA;
      return b.reliabilityScore - a.reliabilityScore;
    });

    // The full check costs about a dozen queries per technician; run a batch of them at once and keep
    // the ranking order, stopping as soon as 20 are eligible (was one technician at a time: 8-11 s).
    const profiles = await firstEligible(
      ranked,
      async (p) => (await technicianEligibility(this.dataSource.manager, p.userId, booking)).eligible,
      CANDIDATE_LIMIT,
      ELIGIBILITY_BATCH,
    );

    const profileUserIds = profiles.map((p) => p.userId);
    const orderCountsByTech = new Map<string, { total: number; completed: number }>();
    if (profileUserIds.length > 0) {
      try {
        const orderRows = await this.dataSource
          .getRepository(TechnicianAssignment)
          .createQueryBuilder('ta')
          .innerJoin('service_orders', 'so', 'so.id = ta.service_order_id')
          .select('ta.technician_id', 'userId')
          .addSelect('COUNT(*)', 'total')
          .addSelect(`COUNT(CASE WHEN so.status = '${ServiceOrderStatus.COMPLETED}' THEN 1 END)`, 'completed')
          .where('ta.technician_id IN (:...profileUserIds)', { profileUserIds })
          .groupBy('ta.technician_id')
          .getRawMany();

        for (const row of orderRows) {
          orderCountsByTech.set(row.userId, {
            total: parseInt(row.total, 10) || 0,
            completed: parseInt(row.completed, 10) || 0,
          });
        }
      } catch {
        // fail-safe
      }
    }

    return profiles.map((tp) => {
      const matchedSkill = tp.skills?.find((s) => s.serviceId === booking.serviceId);
      const counts = orderCountsByTech.get(tp.userId);
      const completedOrdersCount = counts ? counts.completed : 0;
      const totalOrdersCount = counts ? counts.total : 0;
      const completionRate = totalOrdersCount > 0
        ? Math.round((completedOrdersCount / totalOrdersCount) * 1000) / 10
        : tp.reliabilityScore ?? 100;

      return {
        technicianId: tp.id,
        userId: tp.userId,
        fullName: tp.user?.fullName || '',
        avatarUrl: tp.user?.avatarUrl || null,
        averageRating: displayRating(tp.averageRating, tp.ratingCount),
        ratingCount: tp.ratingCount,
        reliabilityScore: tp.reliabilityScore,
        yearsExperience: tp.yearsExperience,
        isAvailable: tp.isAvailable,
        hasPriorityBoost: Boolean(
          tp.priorityBoostUntil && new Date(tp.priorityBoostUntil) > new Date(),
        ),
        listedLaborPrice: matchedSkill?.listedLaborPrice != null ? Number(matchedSkill.listedLaborPrice) : null,
        // What the technician set for the service, else their default; null when they set none (was shown as 30).
        typicalWarrantyDays: matchedSkill?.typicalWarrantyDays ?? tp.defaultLaborWarrantyDays ?? null,
        distanceKm: distanceByProfileId.get(tp.id) ?? null,
        bio: tp.bio || null,
        completedOrdersCount,
        completionRate,
      };
    });
  }

  /**
   * Reschedule a pending/matching booking (PO 08/10/2026). The customer picks a
   * day and a session; an urgent booking that is moved becomes a scheduled one.
   * When a technician already holds the order and is not free in that session,
   * the change is refused so the customer picks another session; the client
   * shows the technician's free sessions from GET /bookings/:id/available-slots.
   */
  async reschedule(
    bookingId: string,
    dto: ScheduleBookingDto,
    customer: { id: string },
  ): Promise<Booking> {
    if (dto.mode === 'urgent') {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Dời lịch thì chọn ngày và buổi (sáng hoặc chiều)');
    }
    const window = resolveBookingWindow(dto, new Date(), 0);
    if ('error' in window) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, window.error);
    // The technician holding the order hears about the new session once it is saved.
    let moved: { technicianId: string; orderId: string; code: string } | null = null;
    const saved = await this.dataSource.transaction(async (manager) => {
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
      // A description-only edit is not a reschedule: same window keeps the
      // invitations, their expiry and the assigned technician.
      if (booking.preferredStartAt?.getTime() === window.start.getTime() &&
          booking.preferredEndAt?.getTime() === window.end.getTime()) {
        if (!dto.description || dto.description === booking.description) return booking;
        booking.description = dto.description;
        await this.auditLogService.logWithManager(manager, {
          actorUserId: customer.id,
          actorRole: Role.CUSTOMER,
          action: 'BOOKING_DESCRIPTION_UPDATE',
          resourceType: 'booking',
          resourceId: bookingId,
          after: { description: dto.description },
        });
        return manager.save(booking);
      }
      booking.preferredStartAt = window.start;
      booking.preferredEndAt = window.end;
      booking.bookingMode = window.mode;
      booking.slot = window.slot;
      if (dto.description) booking.description = dto.description;
      if (order) {
        const assignment = await manager.findOneBy(TechnicianAssignment, { serviceOrderId: order.id, isActive: true });
        if (assignment) {
          await manager.findOne(User, { where: { id: assignment.technicianId }, lock: { mode: 'pessimistic_write' } });
          const eligibility = await technicianEligibility(manager, assignment.technicianId, booking, order.id, { keepingExistingOrder: true });
          if (!eligibility.eligible) {
            throw new BusinessException(ErrorCodes.TECHNICIAN_NOT_ELIGIBLE, 'Kỹ thuật viên của đơn không rảnh buổi này, vui lòng chọn buổi khác', { reason: eligibility.reason });
          }
        }
        if (assignment) moved = { technicianId: assignment.technicianId, orderId: order.id, code: order.code };
        // Without an active assignment the order waits for a replacement; the
        // new window is the one the next technician is invited for.
        await manager.update(ServiceOrder, order.id, { scheduledAt: booking.preferredStartAt, departureWarnedAt: null });
      } else {
        await this.cancelOpenInvitations(manager, bookingId);
        booking.status = BookingStatus.SUBMITTED;
      }
      await this.auditLogService.logWithManager(manager, {
        actorUserId: customer.id,
        actorRole: Role.CUSTOMER,
        action: 'BOOKING_RESCHEDULE',
        resourceType: 'booking',
        resourceId: bookingId,
        after: { mode: window.mode, slot: window.slot, preferredStartAt: window.start, preferredEndAt: window.end, description: dto.description },
      });
      return manager.save(booking);
    });
    const notice = moved as { technicianId: string; orderId: string; code: string } | null;
    if (notice && this.notificationsService) {
      const [y, m, d] = vnDate(window.start).split('-');
      const when = window.slot ? `${BOOKING_SLOTS[window.slot].label}, ${d}/${m}/${y}` : `${d}/${m}/${y}`;
      await this.notificationsService.createNotification({
        userId: notice.technicianId,
        title: 'Khách đã đổi lịch hẹn',
        message: `Đơn #${notice.code} chuyển sang ${when}.`,
        type: 'BOOKING_RESCHEDULED',
        referenceId: notice.orderId,
        referenceType: 'SERVICE_ORDER',
      }).catch(() => undefined);
    }
    return saved;
  }

  private async cancelOpenInvitations(manager: EntityManager, bookingId: string): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(BookingInvitation)
      .set({ status: InvitationStatus.CANCELLED, respondedAt: new Date() })
      .where('booking_id = :bookingId AND status IN (:...statuses)', {
        bookingId,
        statuses: [InvitationStatus.PENDING, InvitationStatus.STANDBY],
      })
      .execute();
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

  /** The technician who held (or finished) the booking's order, if any. */
  private async previousTechnicianId(manager: EntityManager, bookingId: string): Promise<string | null> {
    const order = await manager.findOneBy(ServiceOrder, { bookingId });
    if (!order) return null;
    const last = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: order.id }, order: { assignedAt: 'DESC' } });
    return last?.technicianId ?? null;
  }

  /**
   * Book again from a finished or cancelled booking (PO 08/10/2026): same
   * service and address, a new day and session; the controller then invites
   * the same technician when they are free, otherwise the customer chooses.
   */
  async rebook(oldBookingId: string, customer: { id: string; role: string }, dto: RebookDto): Promise<{ booking: Booking; previousTechnicianId: string | null }> {
    const old = await this.bookingRepo.findOneBy({ id: oldBookingId, customerId: customer.id });
    if (!old) throw new ForbiddenException('Booking not found');
    const order = await this.dataSource.manager.findOneBy(ServiceOrder, { bookingId: old.id });
    const finished = old.status === BookingStatus.CANCELLED
      || (order && [ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED].includes(order.status));
    if (!finished) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Chỉ đặt lại từ đơn đã hoàn thành hoặc đã huỷ');
    if (!old.addressId) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Đơn cũ không còn địa chỉ, vui lòng đặt mới');
    const booking = await this.create(
      {
        serviceId: old.serviceId,
        addressId: old.addressId,
        description: dto.problemDescription?.trim() || old.description,
        mode: dto.mode,
        date: dto.date,
        slot: dto.slot,
        preferredStartAt: dto.preferredStartAt,
        preferredEndAt: dto.preferredEndAt,
        quantity: dto.quantity ?? old.quantity,
        urgency: old.urgency,
        customerNote: dto.customerNote ?? old.customerNote ?? undefined,
      },
      customer,
    );
    return { booking, previousTechnicianId: await this.previousTechnicianId(this.dataSource.manager, old.id) };
  }

  /**
   * Sessions of the next `days` days and whether the relevant technician is
   * free in each: the one holding this booking's order (to reschedule), or with
   * `previous` the one who did it (to book again). Without a technician every
   * future session is open. Only schedule, time off and taken sessions count.
   */
  async availableSessions(
    bookingId: string,
    customer: { id: string },
    days: number,
    previous = false,
  ): Promise<{ technicianId: string | null; sessions: Array<{ date: string; slot: BookingSlot; label: string; available: boolean; reason: string | null }> }> {
    const booking = await this.bookingRepo.findOneBy({ id: bookingId, customerId: customer.id });
    if (!booking) throw new ForbiddenException('Booking not found');
    const manager = this.dataSource.manager;
    const order = await manager.findOneBy(ServiceOrder, { bookingId });
    let technicianId: string | null = null;
    if (previous) technicianId = await this.previousTechnicianId(manager, bookingId);
    else if (order) technicianId = (await manager.findOneBy(TechnicianAssignment, { serviceOrderId: order.id, isActive: true }))?.technicianId ?? null;
    const reasons: Record<string, string> = {
      'Session already booked': 'Thợ đã có lịch buổi này',
      'Technician has time off': 'Thợ nghỉ buổi này',
      'Outside working schedule': 'Thợ không làm buổi này',
      'Assignment schedule conflict': 'Thợ đã có lịch buổi này',
    };
    const now = Date.now();
    const today = vnDate(new Date(now));
    const sessions: Array<{ date: string; slot: BookingSlot; label: string; available: boolean; reason: string | null }> = [];
    for (let i = 0; i < Math.min(Math.max(days, 1), 30); i++) {
      const date = vnDate(new Date(Date.parse(today + 'T00:00:00Z') + i * 86_400_000));
      for (const slot of Object.keys(BOOKING_SLOTS) as BookingSlot[]) {
        const window = slotWindow(date, slot)!;
        if (window.start.getTime() <= now) continue;
        let available = true;
        let reason: string | null = null;
        if (technicianId) {
          const probe = Object.assign(Object.create(Booking.prototype) as Booking, booking, { bookingMode: 'scheduled', slot, preferredStartAt: window.start, preferredEndAt: window.end });
          const verdict = await technicianEligibility(manager, technicianId, probe, previous ? undefined : order?.id, { keepingExistingOrder: true });
          available = verdict.eligible;
          reason = verdict.eligible ? null : reasons[verdict.reason ?? ''] ?? 'Thợ không nhận buổi này';
        }
        sessions.push({ date, slot, label: BOOKING_SLOTS[slot].label, available, reason });
      }
    }
    return { technicianId, sessions };
  }
}
