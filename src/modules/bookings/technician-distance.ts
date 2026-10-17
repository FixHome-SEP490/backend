import { EntityManager } from 'typeorm';
import { Address } from '../users/entities/address.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { SystemConfig } from '../system-config/entities/system-config.entity';
import type { Booking } from './entities/booking.entity';
import { distanceToBooking, technicianOrigin } from './technician-location';

/** A coarse distance: a technician who moves their own GPS fix cannot narrow it down to a house. */
export interface DistanceBand {
  minKm: number;
  /** Null for the open last band. */
  maxKm: number | null;
}

const BAND_EDGES_KM = [1, 3, 5, 10, 20, 40];

/**
 * The band an exact distance falls in: under 1 km, 1-3, 3-5, 5-10, 10-20,
 * 20-40, over 40. Kept this wide on purpose (review 18/10/2026): a 0.1 km value
 * recomputed from an origin the technician controls (their GPS for come-now
 * jobs, their work address) let three readings locate the customer to about
 * 100 m before accepting; a band keeps that to the ward the preview names anyway.
 */
export function toDistanceBand(km: number | null | undefined): DistanceBand | null {
  if (km == null || !Number.isFinite(km) || km < 0) return null;
  let minKm = 0;
  for (const edge of BAND_EDGES_KM) {
    if (km < edge) return { minKm, maxKm: edge };
    minKm = edge;
  }
  return { minKm, maxKm: null };
}

/**
 * How far each booking is from this technician, for the invitation preview
 * (PO 18/10/2026: the technician sees an estimated distance, never the address).
 * Measured from the same origin matching uses: a recent GPS fix for come-now
 * jobs, otherwise the work address. Best effort: any missing piece gives null.
 */
export async function technicianDistances(
  manager: EntityManager,
  technicianUserId: string,
  bookings: Array<Pick<Booking, 'id' | 'bookingMode' | 'latitudeSnapshot' | 'longitudeSnapshot'>>,
  now: number = Date.now(),
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>(bookings.map((b) => [b.id, null]));
  if (!bookings.length) return result;
  try {
    const [profile, address, gpsConfig] = await Promise.all([
      manager.findOne(TechnicianProfile, {
        where: { userId: technicianUserId },
        select: { id: true, lastLat: true, lastLng: true, lastLocationAt: true },
      }),
      manager.findOne(Address, { where: { userId: technicianUserId, isDefault: true }, select: { id: true, lat: true, lng: true } }),
      manager.findOne(SystemConfig, { where: { key: 'matching.gps_fresh_minutes' } }),
    ]);
    const freshMinutes = gpsConfig ? Number(gpsConfig.value) : 15;
    for (const booking of bookings) {
      const mode = booking.bookingMode === 'urgent' ? 'urgent' : 'scheduled';
      const origin = technicianOrigin(mode, profile ?? {}, address, Number.isFinite(freshMinutes) ? freshMinutes : 15, now);
      result.set(booking.id, distanceToBooking(origin, booking));
    }
  } catch {
    // A preview without the distance is still a preview.
  }
  return result;
}
