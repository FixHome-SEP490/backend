// src/modules/technician-skill-verifications/dto/approve-skill-verification.dto.ts
import { PartialType } from '@nestjs/swagger';
import { AttachSkillEvidenceDto } from './attach-skill-evidence.dto';

// Approving needs no file: the manager confirms the skill after seeing the papers in person (PO 09/11/2026). The
// certificate FixHome issues stays optional for the old flow; when sent, all four fields must come together.
export class ApproveSkillVerificationDto extends PartialType(AttachSkillEvidenceDto) {}
