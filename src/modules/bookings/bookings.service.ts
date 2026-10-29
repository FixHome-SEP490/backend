// src/modules/bookings/bookings.service.ts
import { andWhereTextMatches } from '../../shared/utils/list-search';
import { createHash } from 'crypto';
import { firstEligible } from './first-eligible';
import { displayRating } from '../technicians/technician-earnings';
import { NotificationsService } from '../notifications/notifications.service';
import {
  Injectable,
  ForbiddenException,
  Logger,
  NotFoundException, Optional, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, In, Like, SelectQueryBuilder } from 'typeorm';
import { isUUID } from 'class-validator';
import { Booking } from './entities/booking.entity';
import { BookingMedia } from './entities/booking-media.entity';
import { User } from '../users/entities/user.entity';
import { Service } from '../services/entities/service.entity';
import { Address } from '../users/entities/address.entity';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import {
  bookingStageSql,
  orderStageSql,
  type CustomerActivityCounts,
  type RequestStage,
} from '../../shared/utils/customer-activity-stage';
import { BookingStatus, Role, ServicePricingMode, SupportCaseType, UrgencyLevel } from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';

export { CreateBookingDto } from './booking.dto';
import { AttachBookingMediaDto, CreateBookingDto, RebookDto, ScheduleBookingDto } from './booking.dto';
import { BOOKING_SLOTS, resolveBookingWindow, vnDate, type BookingSlot } from './booking-slots';
import { distanceToBooking, servesArea, technicianOrigin } from './technician-location';
import { technicianDistances } from './technician-distance';
import { TechnicianServiceArea } from '../technicians/entities/technician-service-area.entity';
import { loadEligibilityBulk, loadEligibilityPreload, technicianEligibility } from './technician-eligibility';
import { groupSiblings, refuseLoneGroupedBookingAction } from './visit-group-guard';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { OrderStatusHistory } from '../service-orders/entities/order-status-history.entity';
import { SupportCase } from '../support-cases/entities/support-case.entity';
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
import { MAX_BOOKING_MEDIA_UPLOADS, PrivateBookingPhotoClaimService } from '../media/private-booking-photo-claim.service';
import { AiChatSession } from '../ai-diagnosis/entities/ai-chat-session.entity';
import { AiBookingSummary, hasAdvice, toBookingSummary } from '../ai-diagnosis/ai-chat-summary';
import { composeAddressText } from '../../shared/utils/address-text';
import {
  conflictsWithCatalogV2LegacyFixedTier,
  validateCatalogV2DeviceAttributesForBooking,
} from '../../database/catalog-v2/catalog-v2-device-attributes';
import { catalogV2SelectedVariantCode, isCatalogV2Service, resolveCatalogV2Pricing } from '../../database/catalog-v2/catalog-v2-pricing-binding';
import { buildRepairFailureDraft } from './repair-failure-draft';
import type { RepairFailureDraftDto } from './dto/repair-failure-draft.dto';
import { REPAIR_FAILURE_ACTION } from '../service-orders/repair-failure-incident';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { RepairFailureRebook, RepairFailureRebookSource } from './entities/repair-failure-rebook.entity';
import { RepairFailureRebookDto } from './dto/repair-failure-rebook.dto';
import type { CreateVisitGroupDto } from '../visit-groups/visit-group.dto';
import { buildInterruptionDraft } from './interruption-draft';
import { InterruptionRebook, InterruptionRebookSource } from './entities/interruption-rebook.entity';
import { InterruptionRebookDto } from './dto/interruption-rebook.dto';

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

type BookingListOptions = {
  page?: number;
  limit?: number;
  status?: BookingStatus;
  statuses?: BookingStatus[];
  search?: string;
  overdue?: boolean;
  sort?: 'created' | 'appointment';
  stage?: RequestStage;
  excludeVisitGroups?: boolean;
};

/**
 * Filters shared by the customer's list and the staff board (PO 12/10/2026): several states, a
 * text search, appointments already passed or not, newest first or earliest appointment first.
 */
function filterBookingList(qb: SelectQueryBuilder<Booking>, options: BookingListOptions): void {
  if (options.status) qb.andWhere('b.status = :status', { status: options.status });
  if (options.statuses?.length) qb.andWhere('b.status IN (:...statuses)', { statuses: options.statuses });
  andWhereTextMatches(qb, ['b.service_name_snapshot', 'b.description'], options.search);
  if (options.stage) qb.andWhere(bookingStageSql(options.stage, 'b'));
  if (options.overdue === true) qb.andWhere('b.preferred_start_at < now()');
  if (options.overdue === false) qb.andWhere('(b.preferred_start_at IS NULL OR b.preferred_start_at >= now())');
  if (options.sort === 'appointment') qb.orderBy('b.preferredStartAt', 'ASC', 'NULLS LAST').addOrderBy('b.createdAt', 'DESC');
  else qb.orderBy('b.createdAt', 'DESC');
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
  /**
   * `group` (PO 21/10/2026): the booking is one device of a VisitGroup and is
   * written inside the group's own transaction, so either every device of the
   * group is created or none is.
   */
  async create(
    dto: CreateBookingDto,
    customer: { id: string; role: string },
    group?: { manager: EntityManager; visitGroupId: string },
  ): Promise<Booking> {
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

    const catalogV2 = isCatalogV2Service(service.code);
    if (!catalogV2 && catalogV2SelectedVariantCode(dto)) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Phạm vi đã chọn không thuộc dịch vụ này.');
    }
    const isFixed = !catalogV2 && service.pricingMode === ServicePricingMode.FIXED_PRICE;
    const deviceAttributesResult = validateCatalogV2DeviceAttributesForBooking(service.code, dto.deviceAttributes);
    if (deviceAttributesResult.status === 'INVALID_ATTRIBUTES') {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Device attributes are invalid');
    }
    if (deviceAttributesResult.status === 'SERVICE_MISMATCH') {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Device attributes do not match the selected service');
    }
    if (isFixed && deviceAttributesResult.status === 'VALID'
      && deviceAttributesResult.snapshot
      && conflictsWithCatalogV2LegacyFixedTier(service.code, deviceAttributesResult.snapshot)) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Device attributes are invalid');
    }
    const deviceAttributesSnapshot = deviceAttributesResult.status === 'VALID'
      ? deviceAttributesResult.snapshot
      : null;

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
        addressTextSnapshot = composeAddressText([address.line1, address.ward, address.district, address.province]);
        latitudeSnapshot = address.lat != null ? Number(address.lat) : null;
        longitudeSnapshot = address.lng != null ? Number(address.lng) : null;
      }
    }

    if (latitudeSnapshot == null || longitudeSnapshot == null) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Repair address coordinates are required');
    if (isFixed && (service.fixedPrice == null || Number(service.fixedPrice) < 0)) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Service fixed price is not configured');

    const aiSummary = dto.aiSessionId ? await this.aiSummaryFor(dto.aiSessionId, customer.id) : null;

    const inTransaction = <T>(work: (manager: EntityManager) => Promise<T>): Promise<T> =>
      group ? work(group.manager) : this.dataSource.transaction(work);
    const saved = await inTransaction(async (manager) => {
      // Lock the active parent/category and tiers until the immutable snapshot is stored.
      const pricingPreview = catalogV2 ? await resolveCatalogV2Pricing(manager, service.id, dto, true) : null;
      const catalogV2PricingSnapshot = pricingPreview ? { ...pricingPreview, priceBinding: pricingPreview.bindingReady } : null;
      const selectedVariant = catalogV2PricingSnapshot?.selectedVariant;
      // A firm price needs no words from the customer; nothing is invented in their
      // place (PO 21/10/2026). A job quoted on site still needs a description.
      const description = dto.description?.trim() ?? '';
      const firmPrice = catalogV2PricingSnapshot ? !!selectedVariant : isFixed;
      if (!description && !firmPrice) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Vui lòng mô tả sơ bộ tình trạng thiết bị.');
      }
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
        description,
        preferredStartAt: window.start,
        preferredEndAt: window.end,
        bookingMode: window.mode,
        slot: window.slot,
        customerNote: dto.customerNote?.trim() || null,
        deviceAttributesSnapshot,
        catalogV2PricingSnapshot,
        pricingModeSnapshot: catalogV2PricingSnapshot
          ? selectedVariant ? ServicePricingMode.FIXED_PRICE : ServicePricingMode.INSPECTION_REQUIRED
          : service.pricingMode,
        fixedUnitPriceSnapshot: selectedVariant ? selectedVariant.laborPriceVnd : isFixed ? service.fixedPrice : null,
        quantity,
        scopeSnapshot: selectedVariant ? selectedVariant.scopeVi : isFixed ? (service.scopeDescription || service.description || null) : null,
        urgency: dto.urgency || UrgencyLevel.MEDIUM,
        status: BookingStatus.SUBMITTED,
        aiSummary,
        visitGroupId: group?.visitGroupId ?? null,
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
        await (group?.manager ?? this.dataSource).query(
          `UPDATE "ai_diagnoses" AS diagnosis SET "booking_id" = $1 FROM "bookings" AS source WHERE diagnosis."id" = $2 AND diagnosis."booking_id" = source."id" AND source."customer_id" = $3 RETURNING diagnosis."id"`,
          [saved.id, dto.aiDiagnosisId, customer.id],
        );
      } catch (err) {
        this.logger.warn(`Failed to link AI diagnosis ${dto.aiDiagnosisId}: ${err.message}`);
      }
    }

    const audit = {
      actorUserId: customer.id,
      actorRole: customer.role,
      action: 'BOOKING_CREATE',
      resourceType: 'booking',
      resourceId: saved.id,
      after: { serviceId: dto.serviceId, urgency: saved.urgency, ...(group ? { visitGroupId: group.visitGroupId } : {}) },
    };
    if (group) await this.auditLogService.logWithManager(group.manager, audit);
    else await this.auditLogService.log(audit);

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
        ids.length > MAX_BOOKING_MEDIA_UPLOADS ||
        ids.some((id) => typeof id !== 'string' || !isUUID(id)) ||
        new Set(ids.map((id) => id.toLowerCase())).size !== ids.length
      ) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          'Provide at most five photos and two videos as distinct valid Booking upload IDs',
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
    options: BookingListOptions,
  ): Promise<{ data: Booking[]; total: number }> {
    await this.closeOverdueBookings();
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.bookingRepo
      .createQueryBuilder('b')
      .where('b.customerId = :customerId', { customerId })
      .leftJoinAndSelect('b.service', 'service')
      .leftJoinAndSelect('b.media', 'media');

    filterBookingList(qb, options);
    if (options.excludeVisitGroups) {
      qb.andWhere('NOT EXISTS (SELECT 1 FROM visit_group_items vgi WHERE vgi.booking_id = b.id)');
    }
    qb.skip((page - 1) * limit).take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  /** Exact counts of the customer's Activity tabs and their filters, so a client shows numbers without loading every page. */
  async activityCounts(customerId: string): Promise<CustomerActivityCounts> {
    await this.closeOverdueBookings();
    const [orders, bookings] = await Promise.all([
      this.dataSource.query(
        `SELECT
           count(*) FILTER (WHERE ${orderStageSql('in_progress')})::int AS in_progress,
           count(*) FILTER (WHERE ${orderStageSql('completed')})::int AS completed,
           count(*) FILTER (WHERE ${orderStageSql('cancelled')})::int AS cancelled
         FROM service_orders o JOIN bookings b ON b.id = o.booking_id
         WHERE b.customer_id = $1`,
        [customerId],
      ),
      this.dataSource.query(
        `SELECT
           count(*) FILTER (WHERE ${bookingStageSql('no_technician')})::int AS no_technician,
           count(*) FILTER (WHERE ${bookingStageSql('sent')})::int AS sent,
           count(*) FILTER (WHERE ${bookingStageSql('cancelled')})::int AS cancelled
         FROM bookings b
         WHERE b.customer_id = $1`,
        [customerId],
      ),
    ]);
    const o = orders[0] ?? {};
    const b = bookings[0] ?? {};
    const repair = { in_progress: Number(o.in_progress ?? 0), completed: Number(o.completed ?? 0), cancelled: Number(o.cancelled ?? 0) };
    const request = { no_technician: Number(b.no_technician ?? 0), sent: Number(b.sent ?? 0), cancelled: Number(b.cancelled ?? 0) };
    return {
      repair: { all: repair.in_progress + repair.completed + repair.cancelled, ...repair },
      request: { all: request.no_technician + request.sent + request.cancelled, ...request },
    };
  }

  /**
   * SM/Admin board: list all bookings (no customer restriction).
   * Used to find bookings stuck in MATCHING for manual assignment.
   */
  async findAllForStaff(
    options: BookingListOptions,
  ): Promise<{ data: Booking[]; total: number }> {
    await this.closeOverdueBookings();
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.bookingRepo
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.service', 'service')
      .leftJoinAndSelect('b.media', 'media');

    filterBookingList(qb, options);
    qb.skip((page - 1) * limit).take(limit);

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
        // PO 18/10/2026: photos, videos and the description help the technician decide.
        current.media = await manager.find(BookingMedia, { where: { bookingId: id } });
        const distances = await technicianDistances(manager, actor.id, [current]);
        return toTechnicianBookingPreview(current, { distanceKm: distances.get(id) ?? null });
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
        // Photos and invitations would multiply if joined together (PO 14/10/2026: Supabase egress).
        relationLoadStrategy: 'query',
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
      relationLoadStrategy: 'query',
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
    opts: { asVisit?: boolean } = {},
  ): Promise<TechnicianCandidate[]> {
    const isStaff = actor.role === Role.ADMIN || actor.role === Role.SERVICE_MANAGER;
    const booking = await this.bookingRepo.findOne({
      where: isStaff ? { id: bookingId } : { id: bookingId, customerId: actor.id },
      relations: ['service', 'address'],
    });
    if (!booking) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking not found');
    }
    // A visit of several devices is matched through its lead booking by the visit-group
    // endpoint; technicianEligibility() below then asks for every device's skill.
    if (!opts.asVisit) refuseLoneGroupedBookingAction(booking);

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
    // ponytail: one bulk read for the whole ranked list; per-technician queries were ~16 round trips each.
    const bulk = ranked.length ? await loadEligibilityBulk(this.dataSource.manager, booking, ranked) : undefined;
    const profiles = await firstEligible(
      ranked,
      async (p) => (await technicianEligibility(this.dataSource.manager, p.userId, booking, undefined, { bulk })).eligible,
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
    opts: { asVisit?: boolean } = {},
  ): Promise<Booking> {
    if (dto.mode === 'urgent') {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Dời lịch thì chọn ngày và buổi (sáng, chiều hoặc tối)');
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
      // A visit of several devices moves together, through its lead booking (PO 21/10/2026).
      if (!opts.asVisit) refuseLoneGroupedBookingAction(booking);
      const siblings = await groupSiblings(manager, booking, true);
      const siblingIds = siblings.map((sibling) => sibling.id);
      if ([booking, ...siblings].some((b) => ![BookingStatus.SUBMITTED, BookingStatus.MATCHING, BookingStatus.MATCHED].includes(b.status))) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Booking cannot be rescheduled');
      }
      const order = await manager.findOne(ServiceOrder, { where: { bookingId }, lock: { mode: 'pessimistic_write' } });
      const siblingOrders = siblingIds.length
        ? await manager.find(ServiceOrder, { where: { bookingId: In(siblingIds) }, order: { id: 'ASC' }, lock: { mode: 'pessimistic_write' } })
        : [];
      if ([order, ...siblingOrders].some((o) => o && ![ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.EN_ROUTE].includes(o.status))) {
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
      // One move of the arrival session per booking (PO 21/10/2026), per visit for several devices;
      // the description stays editable.
      if ([booking, ...siblings].some((b) => (b.rescheduleCount ?? 0) >= 1)) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Mỗi đơn chỉ được đổi lịch hẹn một lần.');
      }
      booking.rescheduleCount = (booking.rescheduleCount ?? 0) + 1;
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
      if (siblingIds.length) {
        await manager.update(Booking, { id: In(siblingIds) }, {
          rescheduleCount: booking.rescheduleCount,
          preferredStartAt: booking.preferredStartAt,
          preferredEndAt: booking.preferredEndAt,
          bookingMode: booking.bookingMode,
          slot: booking.slot ?? null,
          ...(order ? {} : { status: BookingStatus.SUBMITTED }),
        });
        if (siblingOrders.length) {
          await manager.update(ServiceOrder, { id: In(siblingOrders.map((o) => o.id)) }, { scheduledAt: booking.preferredStartAt, departureWarnedAt: null });
        }
      }
      if (booking.visitGroupId) {
        await manager.update(VisitGroup, booking.visitGroupId, {
          preferredStartAt: booking.preferredStartAt!,
          preferredEndAt: booking.preferredEndAt!,
          bookingMode: booking.bookingMode,
          slot: booking.slot ?? null,
        });
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
      refuseLoneGroupedBookingAction(booking);
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

  /** An owned failed repair is the only source accepted by the final confirmation. */
  async repairFailureDraft(bookingId: string, customer: { id: string; role: string }): Promise<RepairFailureDraftDto> {
    return buildRepairFailureDraft(this.dataSource.manager, bookingId, customer);
  }

  async interruptionDraft(bookingId: string, customer: { id: string; role: string }) {
    return buildInterruptionDraft(this.dataSource.manager, bookingId, customer);
  }

  async confirmInterruptionRebook(
    anchorId: string, dto: InterruptionRebookDto, customer: { id: string; role: string },
    createGroup: (dto: CreateVisitGroupDto, customer: { id: string; role: string }, manager: EntityManager) => Promise<{ id: string; items: Array<{ booking: { id: string } | null }> }>,
  ) {
    if (customer.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    if (!dto || !/^[A-Za-z0-9_-]{8,128}$/.test(dto.idempotencyKey ?? '') || !isUUID(dto.addressId)
      || !/^\d{4}-\d{2}-\d{2}$/.test(dto.date ?? '') || !Object.prototype.hasOwnProperty.call(BOOKING_SLOTS, dto.slot)
      || !Array.isArray(dto.items) || dto.items.length < 1 || dto.items.length > 3
      || dto.items.some(item => !isUUID(item?.sourceBookingId) || !isUUID(item?.sourceCaseId))
      || new Set(dto.items.map(item => item.sourceBookingId)).size !== dto.items.length) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Yêu cầu đặt lại không hợp lệ.');
    }
    const normalized = { ...dto, items: [...dto.items].sort((a, b) => a.sourceBookingId.localeCompare(b.sourceBookingId)) };
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])) : value;
    const fingerprint = createHash('sha256').update(JSON.stringify(stable(normalized))).digest('hex');
    return this.dataSource.transaction(async manager => {
      const anchor = await manager.findOneBy(Booking, { id: anchorId, customerId: customer.id });
      if (!anchor) throw new ForbiddenException('Interrupted order not found or access denied');
      const originalItems = anchor.visitGroupId
        ? await manager.find(VisitGroupItem, { where: { groupId: anchor.visitGroupId }, order: { sequence: 'ASC' } }) : [];
      if (anchor.visitGroupId && (!originalItems.length || !originalItems.some(item => item.bookingId === anchorId && item.outcome === 'interrupted'))) {
        throw new ForbiddenException('Interrupted order not found or access denied');
      }
      const leadId = originalItems[0]?.bookingId ?? anchorId;
      const lead = await manager.findOne(Booking, { where: { id: leadId, customerId: customer.id }, lock: { mode: 'pessimistic_write' } });
      if (!lead) throw new ForbiddenException('Interrupted order not found or access denied');
      const scopeKind = anchor.visitGroupId ? 'visit_group' : 'booking';
      const scopeId = anchor.visitGroupId ?? anchorId;
      const existing = await manager.findOneBy(InterruptionRebook, { customerId: customer.id, scopeKind, scopeId, idempotencyKey: dto.idempotencyKey });
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) throw new BusinessException(ErrorCodes.CONFLICT, 'Khóa xác nhận đã dùng với nội dung khác.');
        const sources = await manager.find(InterruptionRebookSource, { where: { rebookId: existing.id } });
        if (sources.length !== existing.sourceCount || !sources.some(source => source.sourceBookingId === anchorId)) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Biên nhận đặt lại không đầy đủ.');
        }
        const items = sources.sort((a, b) => a.sourceBookingId.localeCompare(b.sourceBookingId)).map(source => ({
          sourceBookingId: source.sourceBookingId, sourceCaseId: source.sourceCaseId, bookingId: source.targetBookingId,
        }));
        return { targetKind: existing.targetVisitGroupId ? 'visit_group' as const : 'booking' as const,
          bookingId: existing.targetVisitGroupId ? null : items[0].bookingId, visitGroupId: existing.targetVisitGroupId, items };
      }
      const draft = await buildInterruptionDraft(manager, anchorId, customer);
      const expected = new Map(draft.items.map(item => [item.sourceBookingId, item]));
      if (expected.size !== dto.items.length || dto.items.some(item => expected.get(item.sourceBookingId)?.sourceCaseId !== item.sourceCaseId)) {
        throw new ForbiddenException('Interrupted order sources do not match');
      }
      const consumed = await manager.find(InterruptionRebookSource, { where: { sourceBookingId: In(dto.items.map(item => item.sourceBookingId)) } });
      if (consumed.length) throw new BusinessException(ErrorCodes.CONFLICT, 'Thiết bị đã được đặt lại.');
      const targetItems = draft.items.map(source => {
        const edit = dto.items.find(item => item.sourceBookingId === source.sourceBookingId)!;
        return { serviceId: source.serviceId, deviceLabel: source.deviceLabel ?? undefined,
          selectedVariantCode: edit.selectedVariantCode === undefined ? source.selectedVariantCode : edit.selectedVariantCode,
          description: edit.description === undefined ? source.description : edit.description,
          deviceAttributes: edit.deviceAttributes === undefined ? source.deviceAttributes : edit.deviceAttributes,
          photoUploadIds: edit.photoUploadIds };
      });
      let targetVisitGroupId: string | null = null;
      let targetBookingIds: string[];
      if (targetItems.length === 1) {
        const child = await this.create({ ...targetItems[0], addressId: dto.addressId, mode: 'scheduled', date: dto.date,
          slot: dto.slot, customerNote: dto.customerNote ?? draft.customerNote ?? undefined, quantity: 1 }, customer, { manager, visitGroupId: null });
        targetBookingIds = [child.id];
      } else {
        const group = await createGroup({ addressId: dto.addressId, mode: 'scheduled', date: dto.date, slot: dto.slot,
          customerNote: dto.customerNote ?? draft.customerNote ?? undefined, items: targetItems }, customer, manager);
        targetVisitGroupId = group.id;
        targetBookingIds = group.items.map(item => item.booking?.id).filter((id): id is string => !!id);
        if (targetBookingIds.length !== targetItems.length) throw new BusinessException(ErrorCodes.CONFLICT, 'Nhóm đặt lại thiếu thiết bị.');
      }
      const receipt = await manager.save(InterruptionRebook, manager.create(InterruptionRebook, {
        customerId: customer.id, scopeKind, scopeId, idempotencyKey: dto.idempotencyKey,
        requestFingerprint: fingerprint, sourceCount: draft.items.length, targetVisitGroupId,
      }));
      const items = draft.items.map((source, index) => ({ sourceBookingId: source.sourceBookingId,
        sourceCaseId: source.sourceCaseId, bookingId: targetBookingIds[index], previousTechnicianId: source.previousTechnicianId }))
        .sort((a, b) => a.sourceBookingId.localeCompare(b.sourceBookingId));
      for (const item of items) await manager.insert(InterruptionRebookSource, {
        rebookId: receipt.id, sourceBookingId: item.sourceBookingId, sourceCaseId: item.sourceCaseId,
        targetBookingId: item.bookingId, previousTechnicianId: item.previousTechnicianId,
      });
      return { targetKind: targetVisitGroupId ? 'visit_group' as const : 'booking' as const,
        bookingId: targetVisitGroupId ? null : targetBookingIds[0], visitGroupId: targetVisitGroupId,
        items: items.map(({ previousTechnicianId: _previousTechnicianId, ...item }) => item) };
    });
  }

  async confirmRepairFailureRebook(
    anchorId: string,
    dto: RepairFailureRebookDto,
    customer: { id: string; role: string },
    createGroup: (dto: CreateVisitGroupDto, customer: { id: string; role: string }, manager: EntityManager) => Promise<{ id: string; items: Array<{ booking: { id: string } | null }> }>,
  ) {
    if (customer.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    if (!dto || !/^[A-Za-z0-9_-]{8,128}$/.test(dto.idempotencyKey ?? '') || !isUUID(dto.addressId)
      || !/^\d{4}-\d{2}-\d{2}$/.test(dto.date ?? '') || !Object.prototype.hasOwnProperty.call(BOOKING_SLOTS, dto.slot)
      || !Array.isArray(dto.items) || dto.items.length < 1 || dto.items.length > 3
      || dto.items.some(item => !isUUID(item?.sourceBookingId) || !isUUID(item?.sourceIncidentId))
      || new Set(dto.items.map(item => item.sourceBookingId)).size !== dto.items.length) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Yêu cầu đặt lại không hợp lệ.');
    }
    const normalized = { ...dto, items: [...dto.items].sort((a, b) => a.sourceBookingId.localeCompare(b.sourceBookingId)) };
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])) : value;
    const fingerprint = createHash('sha256').update(JSON.stringify(stable(normalized))).digest('hex');
    return this.dataSource.transaction(async manager => {
      // The original lead is the lock for the whole source visit. Its lock is
      // acquired first, matching the VisitGroup mutation order.
      const anchor = await manager.findOneBy(Booking, { id: anchorId, customerId: customer.id });
      if (!anchor) throw new ForbiddenException('Failed repair not found or access denied');
      const originalItems = anchor.visitGroupId
        ? await manager.find(VisitGroupItem, { where: { groupId: anchor.visitGroupId }, order: { sequence: 'ASC' } }) : [];
      if (anchor.visitGroupId && (!originalItems.length || !originalItems.some(item => item.bookingId === anchorId))) {
        throw new ForbiddenException('Failed repair not found or access denied');
      }
      const leadId = originalItems[0]?.bookingId ?? anchorId;
      const lockedLead = await manager.findOne(Booking, { where: { id: leadId, customerId: customer.id }, lock: { mode: 'pessimistic_write' } });
      if (!lockedLead) throw new ForbiddenException('Failed repair not found or access denied');
      const scopeKind = anchor.visitGroupId ? 'visit_group' : 'booking';
      const scopeId = anchor.visitGroupId ?? anchorId;
      const existing = await manager.findOneBy(RepairFailureRebook, { customerId: customer.id, scopeKind, scopeId, idempotencyKey: dto.idempotencyKey });
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) throw new BusinessException(ErrorCodes.CONFLICT, 'Khóa xác nhận đã dùng với nội dung khác.');
        const sources = await manager.find(RepairFailureRebookSource, { where: { rebookId: existing.id } });
        if (sources.length !== existing.sourceCount || !sources.some(source => source.sourceBookingId === anchorId)) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Biên nhận đặt lại không đầy đủ.');
        }
        const items = sources.sort((a, b) => a.sourceBookingId.localeCompare(b.sourceBookingId)).map(source => ({
          sourceBookingId: source.sourceBookingId, sourceIncidentId: source.sourceIncidentId, bookingId: source.targetBookingId,
        }));
        return { targetKind: existing.targetVisitGroupId ? 'visit_group' as const : 'booking' as const,
          bookingId: existing.targetVisitGroupId ? null : items[0].bookingId, visitGroupId: existing.targetVisitGroupId, items };
      }
      const draft = await buildRepairFailureDraft(manager, anchorId, customer);
      const expected = new Map(draft.items.map(item => [item.sourceBookingId, item]));
      if (expected.size !== dto.items.length || dto.items.some(item => expected.get(item.sourceBookingId)?.sourceIncidentId !== item.sourceIncidentId)) {
        throw new ForbiddenException('Failed repair sources do not match this incident');
      }
      // This also prevents a different key or an overlapping group submission.
      const consumed = await manager.find(RepairFailureRebookSource, { where: { sourceBookingId: In(dto.items.map(item => item.sourceBookingId)) } });
      if (consumed.length) throw new BusinessException(ErrorCodes.CONFLICT, 'Thiết bị đã được đặt lại.');
      const targetItems = draft.items.map(source => {
        const edit = dto.items.find(item => item.sourceBookingId === source.sourceBookingId)!;
        return { serviceId: source.serviceId, deviceLabel: source.deviceLabel ?? undefined,
          selectedVariantCode: edit.selectedVariantCode === undefined ? source.selectedVariantCode : edit.selectedVariantCode,
          description: edit.description === undefined ? source.description : edit.description,
          deviceAttributes: edit.deviceAttributes === undefined ? source.deviceAttributes : edit.deviceAttributes,
          photoUploadIds: edit.photoUploadIds };
      });
      let targetVisitGroupId: string | null = null;
      let targetBookingIds: string[];
      if (targetItems.length === 1) {
        const child = await this.create({ ...targetItems[0], addressId: dto.addressId, mode: 'scheduled', date: dto.date,
          slot: dto.slot, customerNote: dto.customerNote ?? draft.customerNote ?? undefined, quantity: 1 }, customer, { manager, visitGroupId: null });
        targetBookingIds = [child.id];
      } else {
        const group = await createGroup({ addressId: dto.addressId, mode: 'scheduled', date: dto.date, slot: dto.slot,
          customerNote: dto.customerNote ?? draft.customerNote ?? undefined, items: targetItems }, customer, manager);
        targetVisitGroupId = group.id;
        targetBookingIds = group.items.map(item => item.booking?.id).filter((id): id is string => !!id);
        if (targetBookingIds.length !== targetItems.length) throw new BusinessException(ErrorCodes.CONFLICT, 'Nhóm đặt lại thiếu thiết bị.');
      }
      const header = await manager.save(RepairFailureRebook, manager.create(RepairFailureRebook, {
        customerId: customer.id, scopeKind, scopeId, idempotencyKey: dto.idempotencyKey,
        requestFingerprint: fingerprint, sourceCount: draft.items.length, targetVisitGroupId,
      }));
      const items = draft.items.map((source, index) => ({ sourceBookingId: source.sourceBookingId,
        sourceIncidentId: source.sourceIncidentId, bookingId: targetBookingIds[index] }))
        .sort((a, b) => a.sourceBookingId.localeCompare(b.sourceBookingId));
      for (const item of items) await manager.insert(RepairFailureRebookSource, {
        rebookId: header.id, sourceBookingId: item.sourceBookingId, sourceIncidentId: item.sourceIncidentId, targetBookingId: item.bookingId,
      });
      return { targetKind: targetVisitGroupId ? 'visit_group' as const : 'booking' as const,
        bookingId: targetVisitGroupId ? null : targetBookingIds[0], visitGroupId: targetVisitGroupId, items };
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
    if (order && (await this.dataSource.manager.findOneBy(SupportCase, {
      serviceOrderId: order.id, customerId: customer.id, resolutionCode: 'interrupted_for_rebook',
    }) || (old.visitGroupId && await this.dataSource.manager.findOneBy(VisitGroupItem, {
      groupId: old.visitGroupId, bookingId: old.id, outcome: 'interrupted',
    })))) {
      throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Đơn dừng sửa cần đặt lại qua bản nháp riêng.',
        { draftPath: `/api/v1/bookings/${old.id}/interruption-draft` });
    }
    // The transition history and incident survive loss of the audit receipt.
    // Require both so ordinary cancellations retain their legacy rebook flow.
    const failureTransition = order?.status === ServiceOrderStatus.CANCELLED && old.status === BookingStatus.CANCELLED
      ? await this.dataSource.manager.findOneBy(OrderStatusHistory, {
        serviceOrderId: order.id, fromStatus: ServiceOrderStatus.UNDER_REPAIR,
        toStatus: ServiceOrderStatus.CANCELLED, actorRole: Role.TECHNICIAN, reason: Like('Không sửa được:%'),
      }) : null;
    const failureIncident = failureTransition?.actorUserId
      ? await this.dataSource.manager.findOneBy(SupportCase, {
        serviceOrderId: order.id, bookingId: old.id, customerId: customer.id,
        technicianId: failureTransition.actorUserId, createdByUserId: failureTransition.actorUserId,
        caseType: SupportCaseType.MID_JOB_INTERRUPTION,
        reason: `Không sửa được thiết bị đơn #${order.code}`,
      }) : null;
    // Even an incomplete legacy receipt must not fall back to instant creation
    // and automatic invitation of the technician who reported the failure.
    if (failureIncident || (order && await this.dataSource.manager.findOneBy(AuditLog, { action: REPAIR_FAILURE_ACTION, resourceType: 'service_order', resourceId: order.id })) ||
        (old.visitGroupId && await this.dataSource.manager.findOneBy(VisitGroupItem, { bookingId: old.id, groupId: old.visitGroupId, outcome: 'failed' }))) {
      throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Báo cáo không sửa được cần đặt lại qua bản nháp riêng.', { draftPath: `/api/v1/bookings/${old.id}/repair-failure-draft` });
    }
    const finished = old.status === BookingStatus.CANCELLED
      || (order && [ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED].includes(order.status));
    if (!finished) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Chỉ đặt lại từ đơn đã hoàn thành hoặc đã huỷ');
    if (!old.addressId) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Đơn cũ không còn địa chỉ, vui lòng đặt mới');
    const service = await this.serviceRepo.findOneBy({ id: old.serviceId });
    if (!service?.isActive) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Dịch vụ của đơn cũ đã ngừng, vui lòng đặt yêu cầu mới');
    const base = {
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
      // Giữ thông tin máy và phạm vi đã chốt để đơn mới ra đúng giá như đơn cũ.
      deviceAttributes: old.deviceAttributesSnapshot ?? undefined,
    };
    const variantCode = old.catalogV2PricingSnapshot?.selectedVariant?.variantCode ?? null;
    let booking: Booking;
    try {
      booking = await this.create({ ...base, selectedVariantCode: variantCode }, customer);
    } catch (err) {
      // Phạm vi cũ không còn áp dụng (đã tắt hoặc đổi giá): vẫn đặt lại, thợ báo giá như thường.
      if (!variantCode || !(err instanceof BadRequestException)) throw err;
      booking = await this.create(base, customer);
    }
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
    const dayCount = Math.min(Math.max(days, 1), 30);
    const excludeOrderId = previous ? undefined : order?.id;
    // The technician's schedule, time off and held orders are read once for the whole
    // range, not once per session (PO 21/10/2026: 42 sessions took about 15 s).
    const preload = technicianId
      ? await loadEligibilityPreload(manager, technicianId, {
        start: new Date(now),
        end: new Date(Date.parse(today + 'T00:00:00Z') + (dayCount + 1) * 86_400_000),
      }, excludeOrderId, booking.visitGroupId)
      : undefined;
    const sessions: Array<{ date: string; slot: BookingSlot; label: string; available: boolean; reason: string | null }> = [];
    for (let i = 0; i < dayCount; i++) {
      const date = vnDate(new Date(Date.parse(today + 'T00:00:00Z') + i * 86_400_000));
      for (const slot of Object.keys(BOOKING_SLOTS) as BookingSlot[]) {
        const window = resolveBookingWindow({ mode: 'scheduled', date, slot }, new Date(now), 0);
        if ('error' in window) continue;
        let available = true;
        let reason: string | null = null;
        if (technicianId) {
          const probe = Object.assign(Object.create(Booking.prototype) as Booking, booking, { bookingMode: 'scheduled', slot, preferredStartAt: window.start, preferredEndAt: window.end });
          const verdict = await technicianEligibility(manager, technicianId, probe, excludeOrderId, { keepingExistingOrder: true, preload });
          available = verdict.eligible;
          reason = verdict.eligible ? null : reasons[verdict.reason ?? ''] ?? 'Thợ không nhận buổi này';
        }
        sessions.push({ date, slot, label: BOOKING_SLOTS[slot].label, available, reason });
      }
    }
    return { technicianId, sessions };
  }
}
