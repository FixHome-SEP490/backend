// src/modules/technician-skill-verifications/dto/update-category-evidence.dto.ts
import { OmitType } from '@nestjs/swagger';
import { SubmitCategoryEvidenceDto } from './submit-category-evidence.dto';

// Changes the details and the categories of a paper already sent; the file itself stays (to change the photo the
// technician deletes the paper and sends a new one). Replaces what was stored: a detail left out becomes empty, because
// the app always sends the whole form.
export class UpdateCategoryEvidenceDto extends OmitType(SubmitCategoryEvidenceDto, [
  'storageObjectPath',
  'fileName',
  'fileSize',
  'mimeType',
] as const) {}
