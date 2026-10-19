/**
 * FixHome Catalog V2 — owner-approved S price decisions, 2026-10-18.
 *
 * REVIEW/STAGING ONLY. Never run as a seed automatically and never set a parent
 * Service.fixedPrice from this file. FIXED_PRICE applies to a verified variant
 * plus the approved scope; INSPECTION_REQUIRED amounts are nonbinding advice.
 * S values EXCLUDE part P; no per-part R charge. ΔS needs separate Customer consent.
 * Production activation, safety gates and DB cutover require their own approvals.
 */
export interface OwnerApprovedFixedTier {
  serviceCode: string;
  variantCode: string;
  conditionVi: string;
  laborPriceVnd: number;
}

export const CATALOG_V2_APPROVED_FIXED_TIERS: readonly OwnerApprovedFixedTier[] = [
  { serviceCode: 'AC-02', variantCode: 'AC-02-01', conditionVi: "Treo tường <=1.5 HP", laborPriceVnd: 199000 },
  { serviceCode: 'AC-02', variantCode: 'AC-02-02', conditionVi: "Treo tường 2–2.5 HP", laborPriceVnd: 219000 },
  { serviceCode: 'AC-02', variantCode: 'AC-02-03', conditionVi: "Âm trần cassette tiêu chuẩn", laborPriceVnd: 449000 },
  { serviceCode: 'AC-03', variantCode: 'AC-03-04', conditionVi: "Lắp điều hòa treo tường chuẩn", laborPriceVnd: 449000 },
  { serviceCode: 'WM-02', variantCode: 'WM-02-05', conditionVi: "Máy giặt cửa trên <=9 kg", laborPriceVnd: 399000 },
  { serviceCode: 'WM-02', variantCode: 'WM-02-06', conditionVi: "Máy giặt cửa trên >9 kg", laborPriceVnd: 449000 },
  { serviceCode: 'WM-02', variantCode: 'WM-02-07', conditionVi: "Máy giặt cửa ngang <=9 kg", laborPriceVnd: 599000 },
  { serviceCode: 'WM-02', variantCode: 'WM-02-08', conditionVi: "Máy giặt cửa ngang >9 kg", laborPriceVnd: 699000 },
  { serviceCode: 'WM-03', variantCode: 'WM-03-09', conditionVi: "Lắp đặt máy giặt vị trí chờ sẵn", laborPriceVnd: 299000 },
  { serviceCode: 'WM-05', variantCode: 'WM-05-10', conditionVi: "Máy sấy thông hơi", laborPriceVnd: 399000 },
  { serviceCode: 'WM-05', variantCode: 'WM-05-11', conditionVi: "Máy sấy ngưng tụ", laborPriceVnd: 499000 },
  { serviceCode: 'WM-05', variantCode: 'WM-05-12', conditionVi: "Máy sấy bơm nhiệt", laborPriceVnd: 599000 },
  { serviceCode: 'RO-02', variantCode: 'RO-02-13', conditionVi: "Bảo dưỡng + thay bộ lõi chuẩn", laborPriceVnd: 149000 },
  { serviceCode: 'RO-03', variantCode: 'RO-03-14', conditionVi: "Lắp máy lọc nước vị trí có nguồn", laborPriceVnd: 249000 },
  { serviceCode: 'WH-01', variantCode: 'WH-01-15', conditionVi: "Bình nóng lạnh dân dụng chuẩn", laborPriceVnd: 349000 },
  { serviceCode: 'KT-02', variantCode: 'KT-02-16', conditionVi: "Vệ sinh máy hút mùi gia đình", laborPriceVnd: 349000 },
  { serviceCode: 'EL-02', variantCode: 'EL-02-17', conditionVi: "Thay công tắc ổ cắm CB 1 điểm", laborPriceVnd: 119000 },
  { serviceCode: 'LF-01', variantCode: 'LF-01-18', conditionVi: "Lắp thay 1 bộ đèn", laborPriceVnd: 119000 },
  { serviceCode: 'LF-02', variantCode: 'LF-02-19', conditionVi: "Lắp quạt treo tường", laborPriceVnd: 199000 },
  { serviceCode: 'LF-02', variantCode: 'LF-02-20', conditionVi: "Lắp quạt trần có móc đạt chuẩn", laborPriceVnd: 299000 },
  { serviceCode: 'PU-02', variantCode: 'PU-02-21', conditionVi: "Lắp máy bơm vị trí chờ sẵn", laborPriceVnd: 299000 },
  { serviceCode: 'SA-02', variantCode: 'SA-02-22', conditionVi: "Thay vòi sen siphon chuẩn", laborPriceVnd: 149000 },
  { serviceCode: 'SA-02', variantCode: 'SA-02-23', conditionVi: "Lắp lavabo chuẩn", laborPriceVnd: 349000 },
  { serviceCode: 'SA-02', variantCode: 'SA-02-24', conditionVi: "Lắp bồn cầu chuẩn", laborPriceVnd: 549000 },
  { serviceCode: 'SA-03', variantCode: 'SA-03-25', conditionVi: "Thông tắc chậu lavabo đơn giản", laborPriceVnd: 299000 },
  { serviceCode: 'SA-03', variantCode: 'SA-03-26', conditionVi: "Thông tắc bồn cầu đơn giản", laborPriceVnd: 499000 },
  { serviceCode: 'TV-01', variantCode: 'TV-01-27', conditionVi: "Lắp TV giá treo chuẩn", laborPriceVnd: 299000 },
  { serviceCode: 'LK-03', variantCode: 'LK-03-28', conditionVi: "Lắp khóa thông minh cửa phù hợp", laborPriceVnd: 399000 },
];

export interface OwnerApprovedInspectionReference {
  serviceCode: string;
  suggestedLaborVnd: number;
  confidence: 'RESEARCH_REFERENCE' | 'INTERNAL_PROXY';
  activationGate: 'M1_M2' | 'GATE' | 'LATER';
}

export const CATALOG_V2_INSPECTION_REFERENCES: readonly OwnerApprovedInspectionReference[] = [
  { serviceCode: 'AC-01', suggestedLaborVnd: 249000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'AC-04', suggestedLaborVnd: 699000, confidence: 'INTERNAL_PROXY', activationGate: 'M1_M2' },
  { serviceCode: 'WM-01', suggestedLaborVnd: 249000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'WM-04', suggestedLaborVnd: 249000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'FR-01', suggestedLaborVnd: 249000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'RO-01', suggestedLaborVnd: 199000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'WH-02', suggestedLaborVnd: 249000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'KT-01', suggestedLaborVnd: 249000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'KT-03', suggestedLaborVnd: 199000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'KT-04', suggestedLaborVnd: 249000, confidence: 'INTERNAL_PROXY', activationGate: 'LATER' },
  { serviceCode: 'KT-05', suggestedLaborVnd: 249000, confidence: 'INTERNAL_PROXY', activationGate: 'GATE' },
  { serviceCode: 'EL-01', suggestedLaborVnd: 249000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'LF-03', suggestedLaborVnd: 149000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'PI-01', suggestedLaborVnd: 199000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'PU-01', suggestedLaborVnd: 199000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'SA-01', suggestedLaborVnd: 199000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
  { serviceCode: 'TV-02', suggestedLaborVnd: 249000, confidence: 'INTERNAL_PROXY', activationGate: 'GATE' },
  { serviceCode: 'LK-01', suggestedLaborVnd: 149000, confidence: 'INTERNAL_PROXY', activationGate: 'GATE' },
  { serviceCode: 'LK-02', suggestedLaborVnd: 199000, confidence: 'RESEARCH_REFERENCE', activationGate: 'M1_M2' },
];

// Additional separate reference for the electronic lock class; requires proof
// of lawful access and specialist skill. Never published as a guaranteed price.
export const CATALOG_V2_LOCK_ELECTRONIC_INSPECTION_REFERENCE_VND = 399000;

export const CATALOG_V2_PRICE_POLICY = {
  ownerApprovedSAmounts: true,
  databaseMigrationExecuted: false,
  publicActivation: false,
  surveyFeeAutoChargeApproved: false,
  automaticPerPartLabor: false,
  platformLaborCommissionBps: 1000,
  platformPartsCommissionBps: 0,
  fixhomePartTechBonusRegularBps: 300,
  fixhomePartTechBonusPromoBps: 500,
} as const;

export function getCatalogV2ApprovedFixedTier(serviceCode: string, variantCode: string): OwnerApprovedFixedTier | null {
  return CATALOG_V2_APPROVED_FIXED_TIERS.find((tier) => tier.serviceCode === serviceCode && tier.variantCode === variantCode) ?? null;
}
export function getCatalogV2InspectionReference(serviceCode: string): OwnerApprovedInspectionReference | null {
  return CATALOG_V2_INSPECTION_REFERENCES.find((s) => s.serviceCode === serviceCode) ?? null;
}
