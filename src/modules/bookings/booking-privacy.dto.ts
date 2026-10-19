import type { Booking } from './entities/booking.entity';
import type { BookingMedia } from './entities/booking-media.entity';
import type { BookingInvitation } from './entities/booking-invitation.entity';
import { toDistanceBand, type DistanceBand } from './technician-distance';

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

/** A media item that already went through toBookingMediaResponse (the technician preview builds its own). */
function isSerializedMedia(media: unknown): media is BookingMediaResponseDto {
  return !!media && typeof media === 'object' &&
    typeof (media as BookingMediaResponseDto).isPrivate === 'boolean' &&
    typeof (media as BookingMediaResponseDto).legacyInsecure === 'boolean' &&
    !('privateUploadId' in media);
}

export function toBookingMediaResponse(media: BookingMedia | BookingMediaResponseDto): BookingMediaResponseDto {
  if (isSerializedMedia(media)) return media;
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
  /** Frozen server decision; null on legacy bookings. Does not read current tier prices. */
  catalogV2PricingSnapshot?: Booking['catalogV2PricingSnapshot'];
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
  /** scheduled = one session (morning 08-12 / afternoon 13-18, Vietnam time); urgent = come now. */
  bookingMode: Booking['bookingMode'];
  slot: Booking['slot'] | null;
  /**
   * PO 18/10/2026: the technician judges the job before taking it from the full
   * picture: what the customer wrote, the assistant's summary, the photos and
   * videos, the price basis, and how far it is. The phone number, the exact
   * address and its coordinates, the customer's free note (it often carries a
   * gate code or a phone number) stay out until the order is theirs; the area
   * is only the ward/district and province above.
   */
  description: string | null;
  aiSummary: Booking['aiSummary'] | null;
  media: BookingMediaResponseDto[];
  pricingMode: Booking['pricingModeSnapshot'] | null;
  fixedUnitPrice: number | null;
  /**
   * How far it is, as a coarse band (under 1 km, 1-3, 3-5, 5-10, 10-20, 20-40,
   * over 40), straight line from where this technician is measured (work
   * address, or recent GPS for come-now jobs); null when unknown.
   */
  distanceBand: DistanceBand | null;
}

/** Phone numbers and e-mail addresses typed into free text, hidden from the pre-accept preview. */
const PHONE_PATTERN = /(?:\+?84|0)(?:[\s.-]?\d){8,10}(?!\d)/g;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
export const HIDDEN_PHONE = '[số điện thoại ẩn]';
export const HIDDEN_EMAIL = '[email ẩn]';

/**
 * PO 18/10/2026: the technician sees the problem before accepting, never how
 * to reach the customer. Customers often type their number into the
 * description ("gọi 09..."); it is masked here and shows once the order is theirs.
 */
export function maskContactDetails(text: string | null | undefined): string | null {
  if (text == null) return null;
  return String(text).replace(EMAIL_PATTERN, HIDDEN_EMAIL).replace(PHONE_PATTERN, HIDDEN_PHONE);
}

function maskSummary(summary: Booking['aiSummary']): Booking['aiSummary'] | null {
  if (!summary) return null;
  return {
    ...summary,
    customerText: maskContactDetails(summary.customerText),
    conclusion: maskContactDetails(summary.conclusion),
    notes: Array.isArray(summary.notes) ? summary.notes.map((note) => maskContactDetails(note) ?? '') : summary.notes,
  };
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

export function toTechnicianBookingPreview(
  booking: Booking,
  extras: { distanceKm?: number | null } = {},
): TechnicianBookingPreviewDto {
  const fixedPrice = booking.fixedUnitPriceSnapshot;
  const description = maskContactDetails(booking.description);
  return {
    id: booking.id,
    province: booking.provinceNameSnapshot ?? null,
    district: booking.districtNameSnapshot ?? null,
    serviceName: booking.serviceNameSnapshot ?? null,
    quantity: booking.quantity,
    urgency: booking.urgency,
    preferredStartAt: booking.preferredStartAt ?? null,
    preferredEndAt: booking.preferredEndAt ?? null,
    bookingMode: booking.bookingMode,
    slot: booking.slot ?? null,
    description: description || null,
    aiSummary: maskSummary(booking.aiSummary),
    media: Array.isArray(booking.media) ? booking.media.map(toBookingMediaResponse) : [],
    pricingMode: booking.pricingModeSnapshot ?? null,
    fixedUnitPrice: fixedPrice == null || !Number.isFinite(Number(fixedPrice)) ? null : Number(fixedPrice),
    distanceBand: toDistanceBand(extras.distanceKm),
  };
}

export function toTechnicianInvitationPreview(
  invitation: BookingInvitation,
  extras: { distanceKm?: number | null } = {},
): TechnicianInvitationPreviewDto {
  return {
    id: invitation.id,
    bookingId: invitation.bookingId,
    priorityOrder: invitation.priorityOrder,
    status: invitation.status,
    invitedAt: invitation.invitedAt,
    expiresAt: invitation.expiresAt ?? null,
    booking: toTechnicianBookingPreview(invitation.booking, extras),
  };
}
