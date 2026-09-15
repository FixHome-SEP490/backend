import { Injectable } from '@nestjs/common';
import {
  PaymentVerificationInput,
  PaymentVerificationPort,
  PaymentVerificationResult,
} from './payment-verification.port';

/**
 * Provider-neutral fail-closed boundary. A real provider adapter can replace
 * this token after an owner-approved provider and signature contract exist.
 */
@Injectable()
export class UnconfiguredPaymentVerificationAdapter
  implements PaymentVerificationPort
{
  async verify(
    _input: PaymentVerificationInput,
  ): Promise<PaymentVerificationResult> {
    return {
      outcome: 'unavailable',
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
    };
  }
}
