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
  /** Video khuôn mặt ngắn (liveness) web gửi từ 25/09/2026; thay được ảnh khuôn mặt. */
  FACE_VIDEO = 'face_video',
  CERTIFICATE = 'certificate',
  PORTFOLIO = 'portfolio',
  OTHER = 'other',
}
