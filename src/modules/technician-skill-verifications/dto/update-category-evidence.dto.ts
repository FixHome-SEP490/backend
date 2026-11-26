// src/modules/technician-skill-verifications/dto/update-category-evidence.dto.ts
import { IntersectionType, OmitType, PartialType, PickType } from '@nestjs/swagger';
import { AttachSkillEvidenceDto } from './attach-skill-evidence.dto';
import { SubmitCategoryEvidenceDto } from './submit-category-evidence.dto';

const FILE_FIELDS = ['storageObjectPath', 'fileName', 'fileSize', 'mimeType'] as const;

// Changes the details and the categories of a paper already sent. Replaces what was stored: a detail left out becomes
// empty, because the app always sends the whole form. The four file fields are optional and come together: when they are
// sent the technician has uploaded a new photo for the paper (checked like a new paper), otherwise the file stays.
export class UpdateCategoryEvidenceDto extends IntersectionType(
  OmitType(SubmitCategoryEvidenceDto, FILE_FIELDS),
  PartialType(PickType(AttachSkillEvidenceDto, FILE_FIELDS)),
) {}
