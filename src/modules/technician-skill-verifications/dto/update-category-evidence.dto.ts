// src/modules/technician-skill-verifications/dto/update-category-evidence.dto.ts
import { OmitType } from '@nestjs/swagger';
import { SubmitCategoryEvidenceDto } from './submit-category-evidence.dto';

// Changes the details and the categories of a paper already sent; the file itself stays. DEPRECATED: the app no longer
// edits a paper (it is shared by several skills): to change one the technician deletes it and sends a new one. Kept for
// app versions already released. Replaces what was stored: a detail left out becomes empty.
export class UpdateCategoryEvidenceDto extends OmitType(SubmitCategoryEvidenceDto, [
  'storageObjectPath',
  'fileName',
  'fileSize',
  'mimeType',
] as const) {}
