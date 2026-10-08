import { haversineKm } from '../../shared/utils/geo';

/**
 * Where a technician is measured from (PO 08/10/2026). For an urgent booking a
 * GPS position sent within the freshness window wins: the technician is offered
 * jobs around where they are now. Otherwise (no recent GPS, or a scheduled
 * booking) it is their work address, and they must also serve the booking's
 * district when they have chosen service areas.
 */
export type TechnicianOrigin = { lat: number; lng: number; source: 'gps' | 'address' };

export function technicianOrigin(
  mode: 'scheduled' | 'urgent',
  profile: { lastLat?: number | string | null; lastLng?: number | string | null; lastLocationAt?: Date | string | null },
  address: { lat?: number | string | null; lng?: number | string | null } | null | undefined,
  gpsFreshMinutes: number,
  now: number = Date.now(),
): TechnicianOrigin | null {
  if (mode === 'urgent' && profile.lastLat != null && profile.lastLng != null && profile.lastLocationAt) {
    const age = now - new Date(profile.lastLocationAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age <= gpsFreshMinutes * 60_000) {
      return { lat: Number(profile.lastLat), lng: Number(profile.lastLng), source: 'gps' };
    }
  }
  if (address?.lat == null || address?.lng == null) return null;
  return { lat: Number(address.lat), lng: Number(address.lng), source: 'address' };
}

/**
 * Whether the technician serves the booking's area. No chosen areas: the radius
 * alone decides. Areas chosen but none in the booking's province: not served.
 * The data holds two code systems (pre-2025 district codes of 1-3 digits and
 * post-2025 ward codes of 5 digits) with no reliable mapping, so codes are only
 * compared within the same system; across systems the radius decides.
 */
export function servesArea(
  areas: Array<{ provinceCode: string; districtCode: string }>,
  booking: { provinceSnapshot?: string | null; districtSnapshot?: string | null },
): boolean {
  if (!areas.length) return true;
  if (!booking.provinceSnapshot) return false;
  const inProvince = areas.filter((a) => String(a.provinceCode) === String(booking.provinceSnapshot));
  if (!inProvince.length) return false;
  const code = String(booking.districtSnapshot ?? '');
  if (!/^\d+$/.test(code)) return true;
  const system = (c: string) => (c.length >= 5 ? 'ward' : 'district');
  const comparable = inProvince.filter((a) => /^\d+$/.test(String(a.districtCode)) && system(String(a.districtCode)) === system(code));
  if (!comparable.length) return true;
  return comparable.some((a) => String(a.districtCode) === code);
}

/** Distance in km from the origin to the booking, rounded to 0.1, or null when either point is missing. */
export function distanceToBooking(origin: TechnicianOrigin | null, booking: { latitudeSnapshot?: number | string | null; longitudeSnapshot?: number | string | null }): number | null {
  if (!origin || booking.latitudeSnapshot == null || booking.longitudeSnapshot == null) return null;
  return Math.round(haversineKm(Number(booking.latitudeSnapshot), Number(booking.longitudeSnapshot), origin.lat, origin.lng) * 10) / 10;
}
