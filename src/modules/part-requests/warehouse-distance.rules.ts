/** Straight-line distance for warehouse *ranking*, not road distance or an ETA. */
export type Coordinates = { latitude: number | string | null | undefined; longitude: number | string | null | undefined };

export function point(value: Coordinates | null | undefined): { latitude: number; longitude: number } | null {
  if (value?.latitude === null || value?.latitude === undefined ||
    value.longitude === null || value.longitude === undefined) return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}

export function straightLineKm(a: Coordinates, b: Coordinates): number | null {
  const start = point(a);
  const end = point(b);
  if (!start || !end) return null;
  const rad = Math.PI / 180;
  const dLat = (end.latitude - start.latitude) * rad;
  const dLng = (end.longitude - start.longitude) * rad;
  const hav = Math.sin(dLat / 2) ** 2 +
    Math.cos(start.latitude * rad) * Math.cos(end.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(Math.max(0, 1 - hav)));
}

/** Called only after all-stock eligibility. Stable ID order remains the fallback. */
export function nearestEligible<T extends Coordinates & { id: string }>(
  eligible: T[],
  reference: Coordinates | null,
): T | undefined {
  if (!reference || !point(reference)) return eligible[0];
  const ranked = eligible.map((warehouse) => ({
    warehouse, distance: straightLineKm(reference, warehouse),
  })).filter((candidate): candidate is { warehouse: T; distance: number } => candidate.distance !== null);
  if (!ranked.length) return eligible[0];
  ranked.sort((a, b) => a.distance - b.distance || a.warehouse.id.localeCompare(b.warehouse.id));
  return ranked[0].warehouse;
}
