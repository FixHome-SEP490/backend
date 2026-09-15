import {
  PaymentMode,
  PaymentPurpose,
} from '../../shared/enums';

export const PAYMENT_VERIFICATION_PORT = 'PAYMENT_VERIFICATION_PORT';

export interface PaymentVerificationInput {
  amount: number;
  currency: 'VND';
  mode: PaymentMode;
  purpose: PaymentPurpose;
  invoiceId?: string | null;
  commissionDueId?: string | null;
}

export type PaymentVerificationResult =
  | {
      outcome: 'verified';
      amount: number;
      currency: 'VND';
      providerReference: string;
    }
  | {
      outcome: 'unavailable';
      code: 'PAYMENT_PROVIDER_UNAVAILABLE';
    };

export interface PaymentVerificationPort {
  verify(input: PaymentVerificationInput): Promise<PaymentVerificationResult>;
}
