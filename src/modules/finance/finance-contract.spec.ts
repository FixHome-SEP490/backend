import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { FinanceController } from './finance.controller';
import {
  CashSettlementConfirmationDto,
  CashSettlementDeclarationDto,
  InitiatePaymentDto,
  PlatformDueResponseDto,
  PaymentResponseDto,
} from './dto';
import { PaymentMode, PaymentPurpose, PaymentAttemptStatus } from '../../shared/enums';

describe('Finance API contract metadata', () => {
  it('requires a durable idempotency key without accepting a client amount/provider', async () => {
    const invalid = Object.assign(new InitiatePaymentDto(), {
      idempotencyKey: 'short',
      amount: 1,
      provider: 'momo',
    });
    const errors = await validate(invalid);
    expect(errors.map((error) => error.property)).toEqual(['idempotencyKey']);
  });

  it('validates exact VND cash inputs as typed DTOs', async () => {
    const declaration = Object.assign(new CashSettlementDeclarationDto(), {
      declaredAmount: 100.5,
    });
    const confirmation = Object.assign(new CashSettlementConfirmationDto(), {
      agreed: false,
    });
    const declarationErrors = await validate(declaration);
    const confirmationErrors = await validate(confirmation);
    expect(declarationErrors.map((error) => error.property)).toContain(
      'declaredAmount',
    );
    expect(confirmationErrors.map((error) => error.property)).toContain(
      'disputeReason',
    );
  });

  it('documents typed finance responses and the platform due route', () => {
    const responses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      FinanceController.prototype.listPlatformDues,
    );
    expect(responses['200']).toMatchObject({
      type: PlatformDueResponseDto,
      isArray: true,
    });

    expect(PaymentMode.DEMO).toBe('DEMO');
    expect(PaymentPurpose.INVOICE).toBe('invoice');
    expect(PaymentAttemptStatus.PENDING).toBe('pending');
    expect(PaymentResponseDto).toBeDefined();
  });
});
