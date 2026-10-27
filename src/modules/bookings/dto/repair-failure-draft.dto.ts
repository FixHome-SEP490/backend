import type { Booking } from '../entities/booking.entity';

export interface RepairFailureDraftItem {
  sourceBookingId: string;
  sourceOrderId: string;
  sourceIncidentId: string;
  serviceId: string;
  deviceLabel: string | null;
  selectedVariantCode: string | null;
  description: string;
  deviceAttributes: Booking['deviceAttributesSnapshot'];
  quantity: 1;
  /** Read from the original owned booking; never reusable upload claim IDs. */
  photos: Array<{ mediaId: string; sourceBookingId: string; contentPath: string }>;
}

export interface RepairFailureDraftDto {
  sourceVisitGroupId: string | null;
  targetKind: 'booking' | 'visit_group';
  address: { id: string | null; text: string | null };
  customerNote: string | null;
  items: RepairFailureDraftItem[];
  requiresNewSchedule: true;
  requiresPricingRevalidation: true;
  confirmation: { available: true; path: string };
}
