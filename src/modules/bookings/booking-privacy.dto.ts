import type { Booking } from './entities/booking.entity';
import type { BookingMedia } from './entities/booking-media.entity';
import type { BookingInvitation } from './entities/booking-invitation.entity';

export interface BookingMediaResponseDto {
  id: string;
  url: string | null;
  mimeType: string;
  sizeBytes: number | null;
  isPrivate: boolean;
  legacyInsecure: boolean;
}

export function isLegacyPublicBookingMediaUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

export function toBookingMediaResponse(media: BookingMedia): BookingMediaResponseDto {
  const isPrivate = typeof media.privateUploadId === 'string' && media.privateUploadId.length > 0;
  return {
    id: media.id,
    url: !isPrivate && isLegacyPublicBookingMediaUrl(media.url) ? media.url : null,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes ?? null,
    isPrivate,
    legacyInsecure: !isPrivate,
  };
}

export type BookingResponse<T extends object> = Omit<T, 'media'> & {
  media?: BookingMediaResponseDto[] | null;
};

export function toBookingResponse<T extends object>(booking: T): BookingResponse<T> {
  const withMedia = booking as T & { media?: BookingMedia[] | null };
  if (!Array.isArray(withMedia.media)) return booking as BookingResponse<T>;
  return {
    ...withMedia,
    media: withMedia.media.map(toBookingMediaResponse),
  } as BookingResponse<T>;
}

export interface TechnicianBookingPreviewDto {
  id: string;
  province: string | null;
  district: string | null;
  serviceName: string | null;
  quantity: number;
  urgency: Booking['urgency'];
  preferredStartAt: Date | null;
  preferredEndAt: Date | null;
}

export interface TechnicianInvitationPreviewDto {
  id: string;
  bookingId: string;
  priorityOrder: number;
  status: BookingInvitation['status'];
  invitedAt: Date;
  expiresAt: Date | null;
  booking: TechnicianBookingPreviewDto;
}

export function toTechnicianBookingPreview(booking: Booking): TechnicianBookingPreviewDto {
  return {
    id: booking.id,
    province: booking.provinceNameSnapshot ?? null,
    district: booking.districtNameSnapshot ?? null,
    serviceName: booking.serviceNameSnapshot ?? null,
    quantity: booking.quantity,
    urgency: booking.urgency,
    preferredStartAt: booking.preferredStartAt ?? null,
    preferredEndAt: booking.preferredEndAt ?? null,
  };
}

export function toTechnicianInvitationPreview(
  invitation: BookingInvitation,
): TechnicianInvitationPreviewDto {
  return {
    id: invitation.id,
    bookingId: invitation.bookingId,
    priorityOrder: invitation.priorityOrder,
    status: invitation.status,
    invitedAt: invitation.invitedAt,
    expiresAt: invitation.expiresAt ?? null,
    booking: toTechnicianBookingPreview(invitation.booking),
  };
}
