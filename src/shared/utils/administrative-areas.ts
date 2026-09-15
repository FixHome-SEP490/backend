// src/shared/utils/administrative-areas.ts

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

export const VIETNAM_ADMINISTRATIVE_AREAS: ProvinceMapping[] = [
  {
    code: '79',
    name: 'TP. Hồ Chí Minh',
    aliases: ['tp. hcm', 'hcm', 'tp hcm', 'hồ chí minh', 'ho chi minh', 'saigon', 'sài gòn', 'thành phố hồ chí minh'],
    districts: [
      { code: '760', name: 'Quận 1', aliases: ['q1', 'q.1', 'quan 1', '7901', 'bến nghé', 'bến thành'] },
      { code: '770', name: 'Quận 3', aliases: ['q3', 'q.3', 'quan 3', '7903'] },
      { code: '773', name: 'Quận 4', aliases: ['q4', 'q.4', 'quan 4', '7904'] },
      { code: '774', name: 'Quận 5', aliases: ['q5', 'q.5', 'quan 5', '7905'] },
      { code: '775', name: 'Quận 6', aliases: ['q6', 'q.6', 'quan 6', '7906'] },
      { code: '778', name: 'Quận 7', aliases: ['q7', 'q.7', 'quan 7', '7907', 'phú mỹ hưng'] },
      { code: '776', name: 'Quận 8', aliases: ['q8', 'q.8', 'quan 8', '7908'] },
      { code: '769', name: 'Thành phố Thủ Đức', aliases: ['thủ đức', 'thu duc', 'tp thủ đức', 'quận 2', 'q2', 'quận 9', 'q9', '7902', '7909', '7919'] },
      { code: '771', name: 'Quận 10', aliases: ['q10', 'q.10', 'quan 10', '7910'] },
      { code: '772', name: 'Quận 11', aliases: ['q11', 'q.11', 'quan 11', '7911'] },
      { code: '761', name: 'Quận 12', aliases: ['q12', 'q.12', 'quan 12', '7912'] },
      { code: '764', name: 'Quận Gò Vấp', aliases: ['gò vấp', 'go vap', 'q. gò vấp', '7914'] },
      { code: '765', name: 'Quận Bình Thạnh', aliases: ['bình thạnh', 'binh thanh', 'q. bình thạnh', '7913'] },
      { code: '766', name: 'Quận Tân Bình', aliases: ['tân bình', 'tan binh', 'q. tân bình', '7916'] },
      { code: '767', name: 'Quận Tân Phú', aliases: ['tân phú', 'tan phu', 'q. tân phú', '7917'] },
      { code: '768', name: 'Quận Phú Nhuận', aliases: ['phú nhuận', 'phu nhuan', 'q. phú nhuận', '7915'] },
      { code: '777', name: 'Quận Bình Tân', aliases: ['bình tân', 'binh tan', 'q. bình tân', '7918'] },
      { code: '783', name: 'Huyện Củ Chi', aliases: ['củ chi', 'cu chi', '7920'] },
      { code: '784', name: 'Huyện Hóc Môn', aliases: ['hóc môn', 'hoc mon', '7921'] },
      { code: '785', name: 'Huyện Bình Chánh', aliases: ['bình chánh', 'binh chanh', '7922'] },
      { code: '786', name: 'Huyện Nhà Bè', aliases: ['nhà bè', 'nha be', '7923'] },
      { code: '787', name: 'Huyện Cần Giờ', aliases: ['cần giờ', 'can gio', '7924'] },
    ],
  },
  {
    code: '01',
    name: 'Hà Nội',
    aliases: ['hanoi', 'ha noi', 'tp hà nội', 'tp. hà nội', 'thành phố hà nội'],
    districts: [
      { code: '001', name: 'Quận Ba Đình', aliases: ['ba đình', 'ba dinh', '0101'] },
      { code: '002', name: 'Quận Hoàn Kiếm', aliases: ['hoàn kiếm', 'hoan kiem', '0102'] },
      { code: '003', name: 'Quận Tây Hồ', aliases: ['tây hồ', 'tay ho', '0103'] },
      { code: '004', name: 'Quận Long Biên', aliases: ['long biên', 'long bien', '0104'] },
      { code: '005', name: 'Quận Cầu Giấy', aliases: ['cầu giấy', 'cau giay', '0105'] },
      { code: '006', name: 'Quận Đống Đa', aliases: ['đống đa', 'dong da', '0106'] },
      { code: '007', name: 'Quận Hai Bà Trưng', aliases: ['hai bà trưng', 'hai ba trung', '0107'] },
      { code: '008', name: 'Quận Hoàng Mai', aliases: ['hoàng mai', 'hoang mai', '0108'] },
      { code: '009', name: 'Quận Thanh Xuân', aliases: ['thanh xuân', 'thanh xuan', '0109'] },
      { code: '016', name: 'Quận Nam Từ Liêm', aliases: ['nam từ liêm', 'nam tu liem', '0110'] },
      { code: '019', name: 'Quận Bắc Từ Liêm', aliases: ['bắc từ liêm', 'bac tu liem', '0111'] },
      { code: '021', name: 'Quận Hà Đông', aliases: ['hà đông', 'ha dong', '0112'] },
    ],
  },
];

function normalizeStr(str?: string | null): string {
  if (!str) return '';
  return str.trim().toLowerCase()
    .replace(/^thành phố\s+/i, 'tp. ')
    .replace(/^tỉnh\s+/i, '');
}

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
    p.aliases.some(a => pInput.includes(a)),
  );

  // Default to HCM if cannot match but district looks like HCM or input empty
  if (!matchedProv) {
    matchedProv = VIETNAM_ADMINISTRATIVE_AREAS[0]; // TP. HCM
  }

  // 2. Find district
  let matchedDist = matchedProv.districts.find(d =>
    d.code === input.districtCode ||
    d.code === input.district ||
    normalizeStr(d.name) === dInput ||
    d.aliases.some(a => a === dInput || dInput.includes(a)),
  );

  if (!matchedDist) {
    // If not found in primary, try all provinces
    for (const p of VIETNAM_ADMINISTRATIVE_AREAS) {
      const d = p.districts.find(item =>
        item.code === input.districtCode ||
        item.code === input.district ||
        normalizeStr(item.name) === dInput ||
        item.aliases.some(a => a === dInput || dInput.includes(a)),
      );
      if (d) {
        matchedProv = p;
        matchedDist = d;
        break;
      }
    }
  }

  const provCode = matchedProv.code;
  const provName = matchedProv.name;
  const distCode = matchedDist ? matchedDist.code : (input.districtCode || input.district || '760');
  const distName = matchedDist ? matchedDist.name : (input.district || 'Quận 1');
  const aliases = matchedDist ? [matchedDist.code, ...matchedDist.aliases] : [distCode];

  return {
    provinceCode: provCode,
    provinceName: provName,
    districtCode: distCode,
    districtName: distName,
    districtAliasCodes: aliases,
  };
}
