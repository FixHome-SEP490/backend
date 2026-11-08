// src/shared/enums/skill-level.enum.ts
/** Cấp độ kỹ năng (giữ nguyên giá trị và nhãn đang dùng; nhãn tiếng Việt do client hiển thị). */
export enum SkillLevel {
  BEGINNER = 'BEGINNER',
  INTERMEDIATE = 'INTERMEDIATE',
  ADVANCED = 'ADVANCED',
  EXPERT = 'EXPERT',
}

export const SKILL_LEVELS: string[] = Object.values(SkillLevel);
