import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CheckoutFacts, FailureFacts, SettlementFacts } from './voucher.types';

/** Server-only adapters MUST use the supplied transaction, lock their source rows,
 * verify ownership and immutable references, and never call a payment provider here.
 * No booleans, amounts or settlement verdicts from HTTP are accepted as evidence. */
export abstract class VoucherEvidence {
  abstract checkout(
    manager: EntityManager,
    customerId: string,
    scopeId: string,
  ): Promise<CheckoutFacts>;
  abstract failure(
    manager: EntityManager,
    incidentId: string,
  ): Promise<FailureFacts>;
  abstract settlement(
    manager: EntityManager,
    settlementId: string,
  ): Promise<SettlementFacts>;
  abstract canRelease(
    manager: EntityManager,
    reservationId: string,
  ): Promise<boolean>;
}

@Injectable()
export class UnavailableVoucherEvidence extends VoucherEvidence {
  private unavailable(): never {
    throw new ServiceUnavailableException(
      'Ưu đãi chưa sẵn sàng, vui lòng thử lại sau.',
    );
  }
  async checkout(_manager: EntityManager, _customerId: string, _scopeId: string): Promise<CheckoutFacts> {
    return this.unavailable();
  }
  async failure(_manager: EntityManager, _incidentId: string): Promise<FailureFacts> {
    return this.unavailable();
  }
  async settlement(_manager: EntityManager, _settlementId: string): Promise<SettlementFacts> {
    return this.unavailable();
  }
  async canRelease(_manager: EntityManager, _reservationId: string): Promise<boolean> {
    return this.unavailable();
  }
}
