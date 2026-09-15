import { TechnicianVerification } from './entities/technician-verification.entity';
import { VerificationDocument } from './entities/verification-document.entity';
import {
  TechnicianVerificationResponseDto,
  VerificationDocumentResponseDto,
  VerificationUserSummaryDto,
} from './dto/technician-verification-response.dto';
import { User } from '../users/entities/user.entity';

export function toVerificationDocumentResponse(
  document: VerificationDocument,
): VerificationDocumentResponseDto {
  return {
    id: document.id,
    verificationId: document.verificationId,
    documentType: document.documentType,
    fileName: document.fileName,
    fileSize: document.fileSize,
    mimeType: document.mimeType,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function toVerificationUserSummary(
  user: User,
): VerificationUserSummaryDto {
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

export function toTechnicianVerificationResponse(
  verification: TechnicianVerification,
): TechnicianVerificationResponseDto {
  const response: TechnicianVerificationResponseDto = {
    id: verification.id,
    technicianId: verification.technicianId,
    status: verification.status,
    submittedAt: verification.submittedAt,
    reviewedAt: verification.reviewedAt,
    reviewedById: verification.reviewedById,
    rejectionReason: verification.rejectionReason,
    documents: (verification.documents ?? []).map(toVerificationDocumentResponse),
    reviewedBy: verification.reviewedBy
      ? toVerificationUserSummary(verification.reviewedBy)
      : null,
    createdAt: verification.createdAt,
    updatedAt: verification.updatedAt,
  };

  if (verification.technician) {
    response.technician = toVerificationUserSummary(verification.technician);
  }

  return response;
}

export function toTechnicianVerificationResponseList(
  verifications: TechnicianVerification[],
): TechnicianVerificationResponseDto[] {
  return verifications.map(toTechnicianVerificationResponse);
}
