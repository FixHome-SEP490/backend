// src/modules/bookings/bookings.service.ts
import {
  Injectable,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, In } from 'typeorm';
import { randomUUID } from 'crypto';
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
import { TechnicianServiceArea } from '../technicians/entities/technician-service-area.entity';

export { CreateBookingDto } from './booking.dto';
import { AttachBookingMediaDto, CreateBookingDto, RebookDto, validBookingWindow } from './booking.dto';
import { technicianEligibility } from './technician-eligibility';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { OrderStatusHistory } from '../service-orders/entities/order-status-history.entity';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { BookingInvitationGroup } from './entities/booking-invitation-group.entity';
import { InvitationStatus, ServiceOrderStatus } from '../../shared/enums';
import { resolveServiceArea } from '../../shared/utils/administrative-areas';
import { haversineKm } from '../../shared/utils/geo';
import { AiDiagnosis } from '../ai-diagnosis/entities/ai-diagnosis.entity';
import { activateNextInvitation } from './activate-next-invitation';
import { BusinessConfigService } from '../system-config/business-config.service';
import {
  isLegacyPublicBookingMediaUrl,
  TechnicianBookingPreviewDto,
  toTechnicianBookingPreview,
} from './booking-privacy.dto';
import { PrivateBookingPhotoClaimService } from '../media/private-booking-photo-claim.service';

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
  distanceKm?: number | null;
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
    private readonly privateBookingPhotoClaimService: PrivateBookingPhotoClaimService,
    private readonly configService: BusinessConfigService,
  ) {}

  /**
   * Create a new booking. Validates service, address ownership, and suspension.
   */
  async create(dto: CreateBookingDto, customer: { id: string; role: string }): Promise<Booking> {
    if (customer.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    this.validateCreateMediaInput(dto);
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
        preferredStartAt: dto.preferredStartAt ? new Date(dto.preferredStartAt) : null,
        preferredEndAt: dto.preferredEndAt ? new Date(dto.preferredEndAt) : null,
        pricingModeSnapshot: service.pricingMode,
        fixedUnitPriceSnapshot: isFixed ? service.fixedPrice : null,
        quantity,
        scopeSnapshot: isFixed ? (service.scopeDescription || service.description || null) : null,
        urgency: dto.urgency || UrgencyLevel.MEDIUM,
        status: BookingStatus.SUBMITTED,
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
      if (current.status !== BookingStatus.MATCHED || !invitations.some(
        item => item.technicianId === actor.id && item.status === InvitationStatus.ACCEPTED,
      )) {
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
      if (!fullBooking || fullBooking.status !== BookingStatus.MATCHED ||
          !fullBooking.invitations?.some(item =>
            item.technicianId === actor.id && item.status === InvitationStatus.ACCEPTED)) {
        throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
      }
      fullBooking.invitations = fullBooking.invitations.filter(item => item.technicianId === actor.id);
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
   * Hard-filter by skill + area, then rank by rating, reliability.
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

    // Service-area prefilter (province/district match, incl. legacy district aliases).
    // Optimization only: technicianEligibility() below remains the final authority.
    const targetArea = resolveServiceArea({
      province: booking.provinceSnapshot,
      district: booking.districtSnapshot,
    });

    // Find technicians with the matching skill in the booking's service area
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
      .innerJoin(
        'tp.serviceAreas',
        'serviceArea',
        'serviceArea.provinceCode = :provinceCode AND serviceArea.districtCode IN (:...districtCodes)',
        { provinceCode: targetArea.provinceCode, districtCodes: targetArea.districtAliasCodes },
      )
      .where('tp.isAvailable = :available', { available: true })
      .andWhere('tp.verificationStatus = :verified', { verified: 'verified' })
      .andWhere('(tp.workSuspendedUntil IS NULL OR tp.workSuspendedUntil < :now)', {
        now: new Date(),
      })
      .andWhere('user.status = :active', { active: 'active' });

    const ranked = await qb.getMany();

    // Nearest-first: pull each technician's default work address to compute distance
    // from the booking's coordinate snapshot (both may be missing -> distance omitted).
    const userIds = ranked.map((tp) => tp.userId);
    const workAddresses = userIds.length
      ? await this.addressRepo.find({ where: { userId: In(userIds), isDefault: true } })
      : [];
    const addressByUserId = new Map(workAddresses.map((a) => [a.userId, a]));

    const bookingLat = booking.latitudeSnapshot != null ? Number(booking.latitudeSnapshot) : null;
    const bookingLng = booking.longitudeSnapshot != null ? Number(booking.longitudeSnapshot) : null;
    const distanceByProfileId = new Map<string, number | null>();
    for (const tp of ranked) {
      const addr = addressByUserId.get(tp.userId);
      const distance =
        bookingLat != null && bookingLng != null && addr?.lat != null && addr?.lng != null
          ? Math.round(haversineKm(bookingLat, bookingLng, Number(addr.lat), Number(addr.lng)) * 10) / 10
          : null;
      distanceByProfileId.set(tp.id, distance);
    }

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
      if (Number(b.averageRating) !== Number(a.averageRating)) return Number(b.averageRating) - Number(a.averageRating);
      return b.reliabilityScore - a.reliabilityScore;
    });

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
        distanceKm: distanceByProfileId.get(tp.id) ?? null,
      };
    });
  }

  /**
   * Reschedule a pending/matching booking.
   */
  async reschedule(
    bookingId: string,
    dto: { preferredStartAt: string; preferredEndAt: string; description?: string },
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
      if (dto.description) booking.description = dto.description;
      let action = 'BOOKING_RESCHEDULE';
      let rematched = false;
      if (order) {
        const assignment = await manager.findOneBy(TechnicianAssignment, { serviceOrderId: order.id, isActive: true });
        if (!assignment) throw new BusinessException(ErrorCodes.CONFLICT, 'No active assignment');
        await manager.findOne(User, { where: { id: assignment.technicianId }, lock: { mode: 'pessimistic_write' } });
        const eligibility = await technicianEligibility(manager, assignment.technicianId, booking, order.id);
        if (eligibility.eligible) {
          await manager.update(ServiceOrder, order.id, { scheduledAt: booking.preferredStartAt });
        } else {
          // Assigned technician can no longer serve the new window. The ServiceOrder row is kept (its bookingId is
          // unique — cancelling it would permanently block a future match for this booking) and only unassigned,
          // mirroring the technician-withdrawal-before-arrival path in service-orders.service.ts#cancel: requeue the
          // remaining candidates from the booking's original shortlist and let sequential dispatch try them again
          // against the new time window.
          const now = new Date();
          await manager.update(TechnicianAssignment, { serviceOrderId: order.id, isActive: true }, {
            isActive: false, unassignedAt: now, unassignReason: 'Customer rescheduled; technician unavailable for new time',
          });
          await manager.insert(OrderStatusHistory, {
            serviceOrderId: order.id, fromStatus: order.status, toStatus: order.status,
            actorUserId: customer.id, actorRole: Role.CUSTOMER,
            reason: 'Customer rescheduled outside assigned technician availability; awaiting replacement',
          });
          const previous = await manager.find(BookingInvitation, { where: { bookingId }, order: { priorityOrder: 'ASC' } });
          const last = Math.max(0, ...previous.filter(inv => inv.status === InvitationStatus.ACCEPTED).map(inv => inv.priorityOrder));
          const remaining = previous.filter(inv => inv.priorityOrder > last && inv.status === InvitationStatus.CANCELLED);
          const offset = Math.max(0, ...previous.map(inv => inv.priorityOrder));
          const group = remaining.length > 0
            ? manager.create(BookingInvitationGroup, { id: randomUUID(), bookingId })
            : null;
          if (group) await manager.save(group);
          for (const [index, candidate] of remaining.entries()) {
            await manager.save(BookingInvitation, manager.create(BookingInvitation, {
              groupId: group!.id, bookingId, technicianId: candidate.technicianId, priorityOrder: offset + index + 1,
              status: InvitationStatus.STANDBY, invitedAt: new Date(), expiresAt: null,
            }));
          }
          booking.status = BookingStatus.MATCHING;
          await manager.save(booking);
          // activateNextInvitation may flip the DB row straight to CLOSED (raw update, bypassing this in-memory
          // `booking`) if no candidate remains — re-fetch below rather than blindly re-saving the stale in-memory copy.
          await activateNextInvitation(manager, booking, await this.configService.getInt('matching.invitation_ttl_minutes', 30));
          action = 'BOOKING_RESCHEDULE_REMATCH';
          rematched = true;
        }
      } else {
        await this.cancelOpenInvitations(manager, bookingId);
        booking.status = BookingStatus.SUBMITTED;
      }
      await this.auditLogService.logWithManager(manager, {
        actorUserId: customer.id,
        actorRole: Role.CUSTOMER,
        action,
        resourceType: 'booking',
        resourceId: bookingId,
        after: dto,
      });
      if (rematched) return manager.findOneByOrFail(Booking, { id: bookingId });
      return manager.save(booking);
    });
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
