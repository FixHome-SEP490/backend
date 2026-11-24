// src/modules/technician-skill-verifications/dto/submit-skill-evidence.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SKILL_EVIDENCE_TYPES, SkillEvidenceType } from '../../../shared/enums';
import { Trim } from '../../../shared/validation/input.transforms';
import { AttachSkillEvidenceDto } from './attach-skill-evidence.dto';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Technician's evidence with its structured metadata. Kept apart from AttachSkillEvidenceDto, which the admin's
// approve() also takes for the certificate FixHome issues: that one carries no metadata. Every field is optional so
// clients that send only the file keep working; the group is derived from the type, never taken from the client.
export class SubmitSkillEvidenceDto extends AttachSkillEvidenceDto {
  @ApiPropertyOptional({ enum: SkillEvidenceType, example: SkillEvidenceType.NATIONAL_SKILL_CERTIFICATE })
  @IsOptional() @IsIn(SKILL_EVIDENCE_TYPES, { message: 'evidenceType is not a supported evidence type' })
  evidenceType?: SkillEvidenceType;

  @ApiPropertyOptional({ example: 'Trường Cao đẳng nghề TP.HCM' })
  @IsOptional() @IsString() @Trim() @MaxLength(200)
  issuer?: string;

  @ApiPropertyOptional({ example: 'CC-2021-001234' })
  @IsOptional() @IsString() @Trim() @MaxLength(100)
  referenceNumber?: string;

  @ApiPropertyOptional({ example: '2021-06-15', description: 'Ngày cấp, dạng YYYY-MM-DD' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'issuedAt must be YYYY-MM-DD' })
  issuedAt?: string;

  @ApiPropertyOptional({ example: '2027-06-15', description: 'Ngày hết hạn, dạng YYYY-MM-DD' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'expiresAt must be YYYY-MM-DD' })
  expiresAt?: string;

  @ApiPropertyOptional({ example: 5, description: 'Số năm kinh nghiệm kỹ thuật viên khai theo bằng chứng này' })
  @IsOptional() @IsInt() @Min(0) @Max(60)
  claimedYears?: number;
}
