// src/shared/utils/administrative-areas.ts
import vietnamUnits from '../data/vietnam-administrative-units.json';

export interface ServiceAreaResolution {
  provinceCode: string;
  provinceName: string;
  districtCode: string;
  districtName: string;
  districtAliasCodes: string[];
}

interface DistrictMapping {
  code: string;
  name: string;
  aliases: string[];
}

interface ProvinceMapping {
  code: string;
  name: string;
  aliases: string[];
  districts: DistrictMapping[];
}

interface RawWard {
  Code: string;
  FullName: string;
  ProvinceCode: string;
  PostalCode: string;
}

interface RawProvince {
  Code: string;
  FullName: string;
  PostalCodePrefix: string;
  Wards: RawWard[];
}

function stripDiacritics(str: string): string {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, (m) => (m === 'đ' ? 'd' : 'D'));
}

function normalizeStr(str?: string | null): string {
  if (!str) return '';
  return stripDiacritics(str.trim().toLowerCase())
    .replace(/^thanh pho\s+/i, '')
    .replace(/^tinh\s+/i, '')
    .replace(/^phuong\s+/i, '')
    .replace(/^xa\s+/i, '')
    .replace(/^dac khu\s+/i, '');
}

export const VIETNAM_ADMINISTRATIVE_AREAS: ProvinceMapping[] = (vietnamUnits as RawProvince[]).map((p) => ({
  code: p.Code,
  name: p.FullName,
  aliases: [normalizeStr(p.FullName)],
  districts: p.Wards.map((w) => ({
    code: w.Code,
    name: w.FullName,
    aliases: [normalizeStr(w.FullName)],
  })),
}));

/**
 * Post-July-2025 reform: Vietnam has no district layer anymore (province -> ward directly).
 * "district" here means "ward/commune" — the field/column names are kept as-is
 * (districtCode/districtName) to avoid a wide rename across entities/DTOs/frontend
 * that all just pass these codes through opaquely.
 */
export function resolveServiceArea(input: {
  province?: string | null;
  district?: string | null;
  provinceCode?: string | null;
  districtCode?: string | null;
}): ServiceAreaResolution {
  const pInput = normalizeStr(input.provinceCode || input.province);
  const dInput = normalizeStr(input.districtCode || input.district);

  // 1. Find province
  let matchedProv = VIETNAM_ADMINISTRATIVE_AREAS.find(p =>
    p.code === input.provinceCode ||
    p.code === input.province ||
    normalizeStr(p.name) === pInput ||
    Boolean(pInput && p.aliases.some(a => pInput.includes(a) || a.includes(pInput))),
  );

  // 2. Find district (ward) within the matched province
  let matchedDist = matchedProv
    ? matchedProv.districts.find(d =>
        d.code === input.districtCode ||
        d.code === input.district ||
        normalizeStr(d.name) === dInput ||
        Boolean(dInput && d.aliases.some(a => a === dInput)),
      )
    : undefined;

  if (!matchedDist) {
    // If not found in primary, try all provinces (ward names can repeat nationwide)
    for (const p of VIETNAM_ADMINISTRATIVE_AREAS) {
      const d = p.districts.find(item =>
        item.code === input.districtCode ||
        item.code === input.district ||
        normalizeStr(item.name) === dInput ||
        Boolean(dInput && item.aliases.some(a => a === dInput)),
      );
      if (d) {
        matchedProv = p;
        matchedDist = d;
        break;
      }
    }
  }

  const provCode = matchedProv ? matchedProv.code : (input.provinceCode || input.province || '79');
  const provName = matchedProv ? matchedProv.name : (input.province || 'Thành phố Hồ Chí Minh');
  const distCode = matchedDist ? matchedDist.code : (input.districtCode || input.district || '');
  const distName = matchedDist ? matchedDist.name : (input.district || '');
  const aliases = matchedDist ? [matchedDist.code, ...matchedDist.aliases] : [distCode];

  return {
    provinceCode: provCode,
    provinceName: provName,
    districtCode: distCode,
    districtName: distName,
    districtAliasCodes: aliases,
  };
}
