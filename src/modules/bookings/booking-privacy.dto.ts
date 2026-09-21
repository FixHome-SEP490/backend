import type { Booking } from './entities/booking.entity';
import type { BookingInvitation } from './entities/booking-invitation.entity';

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
