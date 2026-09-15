// src/shared/enums/verification-status.enum.ts
export enum VerificationStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
}

export enum DocumentType {
  CITIZEN_ID_FRONT = 'citizen_id_front',
  CITIZEN_ID_BACK = 'citizen_id_back',
  FACE_PHOTO = 'face_photo',
  CERTIFICATE = 'certificate',
  PORTFOLIO = 'portfolio',
  OTHER = 'other',
}
