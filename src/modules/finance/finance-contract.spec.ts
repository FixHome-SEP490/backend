import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { FinanceController } from './finance.controller';
import { CustomerWalletController } from './customer-wallet.controller';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard, PermissionGuard } from '../../common/guards';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { firstValueFrom, of } from 'rxjs';
import {
  CashSettlementConfirmationDto,
  CashSettlementDeclarationDto,
  InitiatePaymentDto,
  PlatformDueResponseDto,
  PaymentResponseDto,
  NoChargeInvoiceResponseDto,
} from './dto';
import { PaymentMode, PaymentPurpose, PaymentAttemptStatus } from '../../shared/enums';

describe('Finance API contract metadata', () => {
  it('P013 exposes the exact guarded no-charge route and single existing response envelope', async () => {
    const route = CustomerWalletController.prototype.noCharge;
    expect(Reflect.getMetadata(PATH_METADATA, route)).toBe('invoices/:id/no-charge');
    expect(Reflect.getMetadata(METHOD_METADATA, route)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(GUARDS_METADATA, CustomerWalletController)).toEqual([JwtAuthGuard, RolesGuard, PermissionGuard]);
    expect(Reflect.getMetadata(DECORATORS.API_RESPONSE, route)['200'].type).toBe(NoChargeInvoiceResponseDto);
    const data = { invoiceId: 'invoice', paymentStatus: 'paid', settlementMethod: 'NO_CHARGE' };
    const result = await firstValueFrom(new TransformInterceptor().intercept(
      { switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }) } as any,
      { handle: () => of(data) },
    ));
    expect(result).toEqual({ success: true, statusCode: 200, message: 'Success', data });
  });
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
