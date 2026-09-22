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

// Preserve the existing shortlist contract; never serialize entity relations or group state.
export function toBookingInvitationResponse(invitation: BookingInvitation) {
  return {
    id: invitation.id,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
    bookingId: invitation.bookingId,
    technicianId: invitation.technicianId,
    priorityOrder: invitation.priorityOrder,
    status: invitation.status,
    invitedAt: invitation.invitedAt,
    respondedAt: invitation.respondedAt ?? null,
    expiresAt: invitation.expiresAt ?? null,
  };
}

export type BookingResponse<T extends object> = Omit<T, 'media' | 'invitations'> & {
  media?: BookingMediaResponseDto[] | null;
  invitations?: ReturnType<typeof toBookingInvitationResponse>[] | null;
};

export function toBookingResponse<T extends object>(booking: T): BookingResponse<T> {
  const withRelations = booking as T & {
    media?: BookingMedia[] | null;
    invitations?: BookingInvitation[] | null;
  };
  return {
    ...withRelations,
    ...(Array.isArray(withRelations.media)
      ? { media: withRelations.media.map(toBookingMediaResponse) } : {}),
    ...(Array.isArray(withRelations.invitations)
      ? { invitations: withRelations.invitations.map(toBookingInvitationResponse) } : {}),
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
