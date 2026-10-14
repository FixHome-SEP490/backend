import { VerificationStatus } from '../../shared/enums';
import { CustomerVerification } from './entities/customer-verification.entity';

/** What the customer and the admin see of a KYC status; "none" = never submitted. */
export type CustomerKycStatus = 'none' | 'pending' | 'verified' | 'rejected';

export interface CustomerVerificationView {
  id: string;
  customerId: string;
  status: VerificationStatus;
  fullName: string;
  dateOfBirth: string;
  gender: string;
  citizenIdNumber: string;
  address: string;
  submittedAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  verifiedFullName: string | null;
  documents: Array<{
    id: string;
    documentType: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    createdAt: Date;
  }>;
  customer?: {
    id: string;
    fullName: string;
    email: string;
    phoneNumber: string | null;
    status: string;
  };
  reviewedBy?: { id: string; fullName: string } | null;
}

/** pg returns DATE columns as strings already; older rows may surface as Date. */
export function toIsoDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function toCustomerVerificationView(v: CustomerVerification): CustomerVerificationView {
  return {
    id: v.id,
    customerId: v.customerId,
    status: v.status,
    fullName: v.fullName,
    dateOfBirth: toIsoDate(v.dateOfBirth) ?? '',
    gender: v.gender,
    citizenIdNumber: v.citizenIdNumber,
    address: v.fullAddress,
    submittedAt: v.submittedAt,
    reviewedAt: v.reviewedAt ?? null,
    rejectionReason: v.rejectionReason ?? null,
    verifiedFullName: v.verifiedFullName ?? null,
    documents: (v.documents ?? [])
      .slice()
      // Front of the card first, then the back.
      .sort((a, b) => Number(a.documentType === 'citizen_id_back') - Number(b.documentType === 'citizen_id_back'))
      .map((d) => ({
        id: d.id,
        documentType: d.documentType,
        fileName: d.fileName,
        fileSize: d.fileSize,
        mimeType: d.mimeType,
        createdAt: d.createdAt,
      })),
    ...(v.customer
      ? {
          customer: {
            id: v.customer.id,
            fullName: v.customer.fullName,
            email: v.customer.email,
            phoneNumber: v.customer.phoneNumber ?? null,
            status: v.customer.status,
          },
        }
      : {}),
    ...(v.reviewedBy !== undefined
      ? { reviewedBy: v.reviewedBy ? { id: v.reviewedBy.id, fullName: v.reviewedBy.fullName } : null }
      : {}),
  };
}

export function kycStatusOf(v: Pick<CustomerVerification, 'status'> | null | undefined): CustomerKycStatus {
  if (!v) return 'none';
  switch (v.status) {
    case VerificationStatus.PENDING:
      return 'pending';
    case VerificationStatus.VERIFIED:
      return 'verified';
    case VerificationStatus.REJECTED:
      return 'rejected';
    default:
      return 'none';
  }
}
