/**
 * FixHome Catalog V2 — owner-accepted research STAGING fixture.
 *
 * This fixture is intentionally NOT imported into runtime catalog seed or routes.
 * Price bands are non-binding text. In particular, do not convert a range to
 * fixed_price without a separately approved exact attribute-based variant.
 * Existing service IDs, historical quotation snapshots, and FixHome part IDs
 * must be preserved across a future reversible database cutover.
 */
export const CATALOG_V2_POLICY = {
  version: '2026-10-18-owner-review',
  ownerAcceptedCatalogDirection: true,
  publicActivation: false,
  platformLaborCommissionBps: 1000,
  platformPartsCommissionBps: 0,
  fixHomePartTechnicianBonusBps: 300,
  fixHomePartTechnicianPromoBonusBps: 500,
  autoPerSkuReplacementLabor: false,
  sourcePartSkuCountForReconciliationOnly: 792,
  legacyReplacementOperationRulesReferenceOnly: 66,
} as const;

export const CATALOG_V2_CATEGORIES = [
  ['CAT_AC', 'Điều hòa'],
  ['CAT_LAUNDRY', 'Máy giặt & máy sấy'],
  ['CAT_FRIDGE', 'Tủ lạnh'],
  ['CAT_RO', 'Máy lọc nước'],
  ['CAT_HEATER', 'Bình nóng lạnh'],
  ['CAT_KITCHEN', 'Thiết bị nhà bếp'],
  ['CAT_ELECTRIC', 'Điện dân dụng'],
  ['CAT_LIGHT_FAN', 'Đèn & quạt'],
  ['CAT_PIPE', 'Đường ống nước'],
  ['CAT_PUMP', 'Máy bơm nước'],
  ['CAT_SANITARY', 'Thiết bị vệ sinh & thông tắc'],
  ['CAT_TV', 'Tivi & màn hình'],
  ['CAT_LOCK', 'Khóa cửa'],
] as const;

export type CatalogV2Phase = 'M1' | 'M2' | 'GATE' | 'LATER';
export type CatalogV2PriceMode = 'INSPECTION_REQUIRED' | 'FIXED_TIER_PENDING';

export interface CatalogV2DraftService {
  code: string;
  categoryCode: string;
  name: string;
  referencePriceText: string;
  priceMode: CatalogV2PriceMode;
  phase: CatalogV2Phase;
  isActive: false;
  fixedPrice: null;
}

function item(
  code: string, categoryCode: string, name: string, referencePriceText: string,
  priceMode: CatalogV2PriceMode, phase: CatalogV2Phase,
): CatalogV2DraftService {
  return { code, categoryCode, name, referencePriceText, priceMode, phase, isActive: false, fixedPrice: null };
}

// Research reference ranges: owner accepted direction, not a DB-safe single fixed amount.
export const CATALOG_V2_SERVICES: CatalogV2DraftService[] = [
  item('AC-01','CAT_AC','Sửa điều hòa','200–250k tham khảo','INSPECTION_REQUIRED','M1'),
  item('AC-02','CAT_AC','Vệ sinh điều hòa','190–220k treo tường; 400–500k âm trần','FIXED_TIER_PENDING','M1'),
  item('AC-03','CAT_AC','Lắp đặt điều hòa','400–500k/bộ chuẩn','FIXED_TIER_PENDING','M1'),
  item('AC-04','CAT_AC','Tháo hoặc di dời điều hòa','Từ 550k tham khảo; khảo sát','INSPECTION_REQUIRED','M2'),
  item('WM-01','CAT_LAUNDRY','Sửa máy giặt','250k công cơ bản đề xuất','INSPECTION_REQUIRED','M1'),
  item('WM-02','CAT_LAUNDRY','Vệ sinh máy giặt','Cửa trên 380–430k; cửa ngang 590–700k','FIXED_TIER_PENDING','M1'),
  item('WM-03','CAT_LAUNDRY','Lắp đặt máy giặt','250–300k/máy chuẩn','FIXED_TIER_PENDING','M1'),
  item('WM-04','CAT_LAUNDRY','Sửa máy sấy','200–250k tham khảo nội bộ','INSPECTION_REQUIRED','M2'),
  item('WM-05','CAT_LAUNDRY','Vệ sinh máy sấy','400–600k theo cấu hình','FIXED_TIER_PENDING','M2'),
  item('FR-01','CAT_FRIDGE','Sửa tủ lạnh','200–250k tham khảo nội bộ','INSPECTION_REQUIRED','M1'),
  item('RO-01','CAT_RO','Sửa máy lọc nước','180–250k tham khảo nội bộ','INSPECTION_REQUIRED','M1'),
  item('RO-02','CAT_RO','Thay lõi và bảo dưỡng máy lọc nước','120–150k/lần tiêu chuẩn + P','FIXED_TIER_PENDING','M1'),
  item('RO-03','CAT_RO','Lắp đặt máy lọc nước','250k/máy tham khảo','FIXED_TIER_PENDING','M2'),
  item('WH-01','CAT_HEATER','Vệ sinh bình nóng lạnh','300–350k/bình tiêu chuẩn','FIXED_TIER_PENDING','M1'),
  item('WH-02','CAT_HEATER','Sửa bình/máy nước nóng','200–250k tham khảo nội bộ','INSPECTION_REQUIRED','M2'),
  item('KT-01','CAT_KITCHEN','Sửa bếp từ','200–250k tham khảo nội bộ','INSPECTION_REQUIRED','M2'),
  item('KT-02','CAT_KITCHEN','Vệ sinh máy hút mùi','300–350k/máy tiêu chuẩn','FIXED_TIER_PENDING','M2'),
  item('KT-03','CAT_KITCHEN','Sửa máy hút mùi','180–250k tham khảo nội bộ','INSPECTION_REQUIRED','M2'),
  item('KT-04','CAT_KITCHEN','Sửa máy rửa bát','Chưa chốt; khảo sát','INSPECTION_REQUIRED','LATER'),
  item('KT-05','CAT_KITCHEN','Sửa lò vi sóng','Chưa chốt; chỉ khi đủ năng lực','INSPECTION_REQUIRED','GATE'),
  item('EL-01','CAT_ELECTRIC','Sửa sự cố điện dân dụng','200–300k công tham khảo','INSPECTION_REQUIRED','M1'),
  item('EL-02','CAT_ELECTRIC','Lắp hoặc thay thiết bị điện','100–150k/điểm tiêu chuẩn + P','FIXED_TIER_PENDING','M1'),
  item('LF-01','CAT_LIGHT_FAN','Lắp hoặc thay đèn','100–150k/bộ chuẩn + P','FIXED_TIER_PENDING','M1'),
  item('LF-02','CAT_LIGHT_FAN','Lắp quạt trần hoặc quạt treo','Treo tường 150–250k; trần 250–350k có móc chờ','FIXED_TIER_PENDING','M2'),
  item('LF-03','CAT_LIGHT_FAN','Sửa quạt điện','120–180k công tham khảo nội bộ','INSPECTION_REQUIRED','M2'),
  item('PI-01','CAT_PIPE','Sửa rò rỉ hoặc sự cố đường ống nước','150–250k công tham khảo','INSPECTION_REQUIRED','M1'),
  item('PU-01','CAT_PUMP','Sửa máy bơm nước','180–250k công tham khảo nội bộ','INSPECTION_REQUIRED','M1'),
  item('PU-02','CAT_PUMP','Lắp đặt máy bơm nước','250–350k/máy chuẩn','FIXED_TIER_PENDING','M2'),
  item('SA-01','CAT_SANITARY','Sửa thiết bị vệ sinh','150–200k công tham khảo','INSPECTION_REQUIRED','M1'),
  item('SA-02','CAT_SANITARY','Lắp hoặc thay thiết bị vệ sinh','Vòi/sen/siphon ~150k; lavabo ~350k; bồn cầu 450–600k','FIXED_TIER_PENDING','M1'),
  item('SA-03','CAT_SANITARY','Thông tắc bồn cầu/chậu/thoát sàn','Chậu/lavabo từ 250–350k; bồn cầu từ 450–550k','FIXED_TIER_PENDING','M1'),
  item('TV-01','CAT_TV','Lắp TV/giá treo','250–350k TV cơ bản + P giá treo','FIXED_TIER_PENDING','M1'),
  item('TV-02','CAT_TV','Sửa TV','Chưa chốt; cần năng lực thợ','INSPECTION_REQUIRED','GATE'),
  item('LK-01','CAT_LOCK','Mở khóa khẩn cấp','Khóa cơ từ 150k; điện tử khảo sát đến 400k','INSPECTION_REQUIRED','GATE'),
  item('LK-02','CAT_LOCK','Sửa khóa cửa/khóa thông minh','180–250k công tham khảo nội bộ','INSPECTION_REQUIRED','M2'),
  item('LK-03','CAT_LOCK','Lắp khóa thông minh','300–450k tiêu chuẩn tham khảo','FIXED_TIER_PENDING','M2'),
];

// 34 historical service codes: no deletions or FK rewrites in this staging phase.
// Multi-target mapping is intentional: the original intent must be resolved before booking.
export const CATALOG_V2_OLD_CODE_CROSSWALK: Record<string, readonly string[]> = {
  KIEM_TRA_CHAN_DOAN_THIET_BI: [],
  SUA_DIEU_HOA:['AC-01'], SUA_MAY_GIAT:['WM-01'], SUA_TU_LANH:['FR-01'],
  VE_SINH_DIEU_HOA:['AC-02','AC-01'],
  VE_SINH_DIEU_HOA_1HP:['AC-02'], VE_SINH_DIEU_HOA_2HP:['AC-02'],
  VE_SINH_DIEU_HOA_AM_TRAN:['AC-02'],
  VE_SINH_MAY_GIAT_CUA_NGANG_GT9:['WM-02'],
  VE_SINH_MAY_GIAT_CUA_NGANG_LE9:['WM-02'],
  VE_SINH_MAY_GIAT_CUA_TREN_GT9:['WM-02'],
  VE_SINH_MAY_GIAT_CUA_TREN_LE9:['WM-02'],
  VE_SINH_MAY_SAY:['WM-05'],
  LAP_DEN_TRAN_CO_BAN:['LF-01'],
  LAP_QUAT_DEN:['LF-01','LF-02','EL-02'],
  LAP_QUAT_TRAN_CO_BAN:['LF-02'], LAP_QUAT_TREO_TUONG:['LF-02'],
  LAP_TV_GIA_TREO:['TV-01'],
  SUA_CHAP_DIEN:['EL-01'], SUA_RO_RI_NUOC:['PI-01'],
  THAY_CONG_TAC_DIEN:['EL-02'], THAY_O_CAM_DIEN:['EL-02'],
  THAY_SIPHON_LAVABO:['SA-02'], THAY_THIET_BI_VE_SINH:['SA-02'],
  THAY_VOI_NUOC:['SA-02'], THAY_VOI_SEN:['SA-02'],
  VE_SINH_BINH_NONG_LANH:['WH-01'], LAP_MAY_LOC_NUOC:['RO-03'],
  SUA_BEP_TU:['KT-01'], SUA_MAY_HUT_MUI:['KT-02','KT-03'],
  SUA_MAY_RUA_CHEN:['KT-04'], MO_KHOA_KHAN_CAP:['LK-01'],
  SUA_KHOA_THONG_MINH:['LK-02'], DICH_VU_KHAC:[],
} as const;

// Explicit assisted triage instead of an incorrect 14th category or generic repair booking.
export function mapLegacyCodeForBooking(oldCode: string): string | null {
  const targets = CATALOG_V2_OLD_CODE_CROSSWALK[oldCode];
  return targets?.length === 1 ? targets[0] : null;
}
