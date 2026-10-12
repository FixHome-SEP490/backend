import { foldVietnamese } from '../../modules/technicians/admin-technicians.service';

/**
 * One readable address line (PO 12/10/2026). The map search fills line1 with the
 * whole place ("…, 700000 Phường Đông Hòa, Việt Nam") and, since the 2025 merger,
 * many addresses have no district so the ward is stored twice; joined naively the
 * order screens showed "…, Việt Nam, Phường Đông Hòa, Phường Đông Hòa, TP. Hồ Chí Minh".
 * This drops 6-digit postcodes, the country and any part already said, keeping
 * the first spelling and the original order. It only tidies text: saved
 * snapshots are not rewritten, they read back tidied.
 */
export function tidyAddressText(text: string | null | undefined): string {
  if (!text) return '';
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of text.split(',')) {
    const part = raw
      .replace(/^\s*\d{6}\s+/, '')
      .replace(/\s+\d{6}\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!part || /^\d{6}$/.test(part)) continue;
    const key = foldVietnamese(part).replace(/^tp\.?\s*/, 'thanh pho ');
    if (key === 'viet nam' || key === 'vietnam') continue;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(part);
  }
  return kept.join(', ');
}

/** The booking's address line from a saved address. */
export function composeAddressText(parts: Array<string | null | undefined>): string {
  return tidyAddressText(parts.filter(Boolean).join(', '));
}
