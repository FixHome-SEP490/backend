import { TechnicianSkillVerification } from '../technicians/entities/technician-skill-verification.entity';
import { VerificationDocument } from '../technician-verifications/entities/verification-document.entity';
import { User } from '../users/entities/user.entity';
import {
  SkillVerificationDocumentResponseDto,
  SkillVerificationResponseDto,
} from './dto/skill-verification-response.dto';
import { VerificationUserSummaryDto } from '../technician-verifications/dto';

function toDocumentResponse(
  document: VerificationDocument,
): SkillVerificationDocumentResponseDto {
  return {
    id: document.id,
    documentType: document.documentType,
    fileName: document.fileName,
    fileSize: document.fileSize,
    mimeType: document.mimeType,
    issuedById: document.issuedById,
    createdAt: document.createdAt,
  };
}

function toUserSummary(user: User): VerificationUserSummaryDto {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
    isActive: user.isActive,
    avatarUrl: user.avatarUrl ?? null,
  };
}

export function toSkillVerificationResponse(
  verification: TechnicianSkillVerification,
): SkillVerificationResponseDto {
  const skill = verification.technicianSkill;
  const response: SkillVerificationResponseDto = {
    id: verification.id,
    technicianSkillId: verification.technicianSkillId,
    technicianId: skill?.technicianId,
    serviceId: skill?.serviceId,
    serviceName: skill?.service?.name,
    status: verification.status,
    submittedAt: verification.submittedAt,
    reviewedAt: verification.reviewedAt,
    rejectionReason: verification.rejectionReason,
    documents: (verification.documents ?? []).map(toDocumentResponse),
    reviewedBy: verification.reviewedBy ? toUserSummary(verification.reviewedBy) : null,
    createdAt: verification.createdAt,
    updatedAt: verification.updatedAt,
  };

  if (skill?.technician?.user) {
    response.technician = toUserSummary(skill.technician.user);
  }

  return response;
}

export function toSkillVerificationResponseList(
  verifications: TechnicianSkillVerification[],
): SkillVerificationResponseDto[] {
  return verifications.map(toSkillVerificationResponse);
}
