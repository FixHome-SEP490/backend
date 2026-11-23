// src/shared/enums/skill-evidence.enum.ts

/** Loại bằng chứng kỹ năng kỹ thuật viên nộp cho một dịch vụ (PO 23/11/2026). */
export enum SkillEvidenceType {
  NATIONAL_SKILL_CERTIFICATE = 'national_skill_certificate',
  VOCATIONAL_DIPLOMA = 'vocational_diploma',
  ELECTRICAL_SAFETY_CARD = 'electrical_safety_card',
  MANUFACTURER_TRAINING = 'manufacturer_training',
  EMPLOYER_CONFIRMATION = 'employer_confirmation',
  SOCIAL_INSURANCE = 'social_insurance',
  WORK_PHOTOS = 'work_photos',
  OTHER = 'other',
}

/** Độ tin cậy: chính thức (cơ quan cấp), kiểm chứng được (bên thứ ba), tự chứng minh. */
export enum SkillEvidenceGroup {
  OFFICIAL = 'official',
  VERIFIABLE = 'verifiable',
  SELF_DECLARED = 'self_declared',
}

/** Kết quả người duyệt đánh giá một bằng chứng. */
export enum SkillEvidenceReviewStatus {
  PENDING = 'pending',
  VALID = 'valid',
  INVALID = 'invalid',
  NEED_MORE = 'need_more',
}

/** Nhóm tin cậy suy ra từ loại bằng chứng; client không được tự chọn nhóm. */
export const SKILL_EVIDENCE_GROUP_BY_TYPE: Record<SkillEvidenceType, SkillEvidenceGroup> = {
  [SkillEvidenceType.NATIONAL_SKILL_CERTIFICATE]: SkillEvidenceGroup.OFFICIAL,
  [SkillEvidenceType.VOCATIONAL_DIPLOMA]: SkillEvidenceGroup.OFFICIAL,
  [SkillEvidenceType.ELECTRICAL_SAFETY_CARD]: SkillEvidenceGroup.OFFICIAL,
  [SkillEvidenceType.MANUFACTURER_TRAINING]: SkillEvidenceGroup.OFFICIAL,
  [SkillEvidenceType.EMPLOYER_CONFIRMATION]: SkillEvidenceGroup.VERIFIABLE,
  [SkillEvidenceType.SOCIAL_INSURANCE]: SkillEvidenceGroup.VERIFIABLE,
  [SkillEvidenceType.WORK_PHOTOS]: SkillEvidenceGroup.SELF_DECLARED,
  [SkillEvidenceType.OTHER]: SkillEvidenceGroup.SELF_DECLARED,
};

export const SKILL_EVIDENCE_TYPES: string[] = Object.values(SkillEvidenceType);
