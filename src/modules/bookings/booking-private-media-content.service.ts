import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager, In, MoreThan } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { BookingStatus, InvitationStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { PrivateBookingPhotoStorage } from '../media/private-booking-photo-storage.service';
import { PrivateBookingPhotoUpload } from '../media/entities/private-booking-photo-upload.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { isDbUuid } from '../../shared/utils/db-uuid';
import { BookingMedia } from './entities/booking-media.entity';
import { Booking } from './entities/booking.entity';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { maxBytesFor, mediaKindOf, type ImageMimeType, type MediaKind, type VideoMimeType } from '../../shared/utils/media-signature';
import { MediaStreamTokens, PrivateVideoService, VideoUnavailableError, type VideoStream } from '../../shared/cloudinary';

const SAFE_MEDIA_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']);

interface AuthorizedMedia {
  objectRef: string;
  ownerUserId: string;
  kind: MediaKind;
  mimeType: string;
}

/** A viewing link for one booking video, relative to the API base. */
export interface BookingVideoLink {
  url: string;
  posterUrl: string;
  expiresAt: string;
}

const GRANT_RECHECK_MS = 60_000;

export interface PrivateBookingImageContent {
  buffer: Buffer;
  mimeType: ImageMimeType | VideoMimeType;
}

@Injectable()
export class BookingPrivateMediaContentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly privateStorage: PrivateBookingPhotoStorage,
    @Optional() private readonly videos?: PrivateVideoService,
    @Optional() private readonly tokens?: MediaStreamTokens,
  ) {}

  private readonly grants = new Map<string, { until: number; media: AuthorizedMedia }>();

  async download(
    bookingId: string,
    mediaId: string,
    actor: { id: string; role: string },
  ): Promise<PrivateBookingImageContent> {
    // Shape only, not isUUID(): seeded accounts and their bookings have non-RFC-4122 ids.
    if (!isDbUuid(bookingId) || !isDbUuid(mediaId) || !actor || !isDbUuid(actor.id)) this.notFound();

    const authorizedObject = await this.dataSource.transaction((manager) => this.authorize(manager, bookingId, mediaId, actor, true));

    // The DB authorization snapshot is committed before provider I/O. A reassignment or
    // cancellation may begin after that commit and before bytes finish downloading; keeping
    // DB locks across the remote request would hold scarce connections and risk lock stalls.
    try {
      const content = await this.privateStorage.download(
        authorizedObject.objectRef,
        authorizedObject.ownerUserId,
      );
      if (
        !content ||
        !Buffer.isBuffer(content.buffer) ||
        content.buffer.length === 0 ||
        content.buffer.length > maxBytesFor(authorizedObject.kind) ||
        !SAFE_MEDIA_MIME_TYPES.has(content.mimeType) ||
        mediaKindOf(content.mimeType) !== authorizedObject.kind
      ) {
        throw new Error('Invalid private Booking image content');
      }
      return content;
    } catch {
      // Do not expose storage references, provider response bodies, or secret-bearing errors.
      throw new ServiceUnavailableException('Private Booking photo content is unavailable');
    }
  }


  /**
   * A viewing link for a booking video, so the player streams and seeks it
   * instead of downloading it whole first (PO 18/10/2026: weak connections).
   */
  async videoLink(bookingId: string, mediaId: string, actor: { id: string; role: string }): Promise<BookingVideoLink> {
    if (!isDbUuid(bookingId) || !isDbUuid(mediaId) || !actor || !isDbUuid(actor.id)) this.notFound();
    const media = await this.authorize(this.dataSource.manager, bookingId, mediaId, actor, false);
    if (media.kind !== 'video') this.notFound();
    if (!this.tokens || !this.videos?.configured) throw new ServiceUnavailableException('Private Booking video is unavailable');
    const { token, expiresAt } = this.tokens.issue({ k: 'b', id: mediaId, b: bookingId, u: actor.id, r: actor.role });
    return { url: `/bookings/media/stream/${token}`, posterUrl: `/bookings/media/stream/${token}/poster`, expiresAt };
  }

  /**
   * Opens the video a link names, with the viewer's byte range. The holder's
   * right to see it is checked again (an invitation may have expired, an order
   * may have changed hands), at most once a minute per link. Null for a link
   * that is forged, expired or no longer allowed.
   */
  async openVideo(token: string, range: string | undefined, part: 'video' | 'poster'): Promise<VideoStream | null> {
    const grant = this.tokens?.verify(token, 'b');
    if (!grant || !grant.b || !this.videos) return null;
    let media: AuthorizedMedia;
    const cached = this.grants.get(token);
    if (cached && cached.until > Date.now()) {
      media = cached.media;
    } else {
      try {
        media = await this.authorize(this.dataSource.manager, grant.b, grant.id, { id: grant.u, role: grant.r }, false);
      } catch {
        this.grants.delete(token);
        return null;
      }
      if (media.kind !== 'video') return null;
      if (this.grants.size > 2000) this.grants.clear();
      this.grants.set(token, { until: Date.now() + GRANT_RECHECK_MS, media });
    }
    const { publicId, plan } = this.privateStorage.videoObject(media.objectRef, media.ownerUserId);
    try {
      return part === 'poster'
        ? await this.videos.openPoster(publicId, plan)
        : await this.videos.open(publicId, plan, media.mimeType as VideoMimeType, range);
    } catch (error) {
      if (error instanceof VideoUnavailableError) throw new ServiceUnavailableException('Private Booking video is unavailable');
      throw error;
    }
  }

  /**
   * Who may see this booking's media: the owner, staff, the technician holding
   * the order, and the technician it is offered to right now (PO 18/10/2026).
   * With `lock` the rows are locked in this transaction (byte downloads); a
   * video stream re-checks without locking, once a minute per link.
   */
  private async authorize(
    manager: EntityManager,
    bookingId: string,
    mediaId: string,
    actor: { id: string; role: string },
    lock: boolean,
  ): Promise<AuthorizedMedia> {
    const locked = lock ? { lock: { mode: 'pessimistic_write' as const } } : {};
    // Lock order is Booking -> ServiceOrder -> TechnicianAssignment. This matches
    // booking matching/withdrawal flows and prevents a reassignment snapshot from
    // being read halfway through its transaction.
    const booking = await manager.findOne(Booking, {
      where: { id: bookingId },
      ...locked,
    });
    if (!booking) this.notFound();

    const isStaff = actor.role === Role.ADMIN || actor.role === Role.SERVICE_MANAGER;
    const isOwner = actor.role === Role.CUSTOMER && actor.id === booking.customerId;
    // PO 18/10/2026: the technician the booking is offered to right now sees its photos and videos to decide.
    // A visit of several devices is offered through its lead booking (PO 21/10/2026): the
    // invitation there shows every device of the visit.
    const invitedThrough = booking.visitGroupId
      ? In((await manager.find(Booking, { select: { id: true }, where: { visitGroupId: booking.visitGroupId } })).map((row) => row.id))
      : booking.id;
    const isInvited = !isStaff && !isOwner && actor.role === Role.TECHNICIAN &&
      booking.status === BookingStatus.MATCHING &&
      !!(await manager.findOne(BookingInvitation, {
        where: { bookingId: invitedThrough, technicianId: actor.id, status: InvitationStatus.PENDING, expiresAt: MoreThan(new Date()) },
      }));
    if (!isStaff && !isOwner && !isInvited) {
      if (actor.role !== Role.TECHNICIAN || booking.status !== BookingStatus.MATCHED) this.notFound();

      const order = await manager.findOne(ServiceOrder, {
        where: { bookingId: booking.id },
        ...locked,
      });
      if (!order || order.status === ServiceOrderStatus.CANCELLED) this.notFound();

      const assignment = await manager.findOne(TechnicianAssignment, {
        where: { serviceOrderId: order.id, technicianId: actor.id, isActive: true },
        ...locked,
      });
      if (!assignment) this.notFound();
    }

    const media = await manager.findOne(BookingMedia, {
      where: { id: mediaId, bookingId: booking.id },
    });
    if (!media || !media.privateUploadId || !isDbUuid(media.privateUploadId)) this.notFound();

    const upload = await manager.findOne(PrivateBookingPhotoUpload, {
      where: { id: media.privateUploadId },
    });
    if (
      !upload ||
      upload.id !== media.privateUploadId ||
      upload.claimedBookingId !== booking.id ||
      upload.ownerUserId !== booking.customerId ||
      typeof upload.objectRef !== 'string' ||
      upload.objectRef.length === 0
    ) {
      this.notFound();
    }

    return { objectRef: upload.objectRef, ownerUserId: upload.ownerUserId, kind: mediaKindOf(upload.mimeType), mimeType: upload.mimeType };
  }

  private notFound(): never {
    throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking media not found');
  }
}
