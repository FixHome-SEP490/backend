import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FundedFinanceController } from './finance.controller';
import { VoucherCashConfirmationDto, VoucherCashDeclarationDto, VoucherReservationDto } from './dto';
import { Role } from '../../shared/enums';
import { GUARDS_METADATA, HTTP_CODE_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, PERMISSION_KEY } from '../../common/decorators';
import { JwtAuthGuard, PermissionGuard, RolesGuard } from '../../common/guards';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { FinanceModule } from './finance.module';

const reservationId = '11111111-1111-4111-8111-111111111111';
const customer = { user: { id: 'customer-1', role: Role.CUSTOMER }, ip: '127.0.0.1', headers: {} };
const technician = { user: { id: 'technician-1', role: Role.TECHNICIAN }, ip: '127.0.0.1', headers: {} };

function setup() {
  const finance = {
    assertFundedCollectionReady: vi.fn(async () => {}),
    payInvoiceWithWallet: vi.fn(async () => ({ paid: true, amount: 50000 })),
    createVnpayPaymentUrl: vi.fn(async () => ({ paymentUrl: 'https://pay.example' })),
    declareCashSettlement: vi.fn(async () => ({ status: 'pending_confirmation' })),
    confirmVoucherCashByReservation: vi.fn(async () => ({ status: 'confirmed' })),
    payVisitWithWallet: vi.fn(async () => ({ paid: true, amount: 50000 })),
    createVisitVnpayUrl: vi.fn(async () => ({ paymentUrl: 'https://pay.example' })),
    declareVisitCash: vi.fn(async () => ({ status: 'pending_confirmation' })),
    confirmVoucherVisitCashByReservation: vi.fn(async () => ({ status: 'verified' })),
    closeVoucherZeroDue: vi.fn(async () => ({ paid: true, amount: 0 })),
  };
  const controller = new FundedFinanceController(finance as never);
  return { finance, controller };
}

describe('funded finance HTTP adapter', () => {
  it.each(['soloWallet', 'soloVnpay', 'soloCashDeclare', 'soloCashConfirm', 'soloZero', 'visitZero',
    'visitWallet', 'visitVnpay', 'visitCashDeclare', 'visitCashConfirm'] as const)(
    '%s remains fail-closed before any paid collection', async method => {
      const { finance, controller } = setup();
      finance.assertFundedCollectionReady.mockRejectedValueOnce(new BusinessException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Funding unavailable'));
      const body = { voucherReservationId: reservationId, declaredAmount: 50000, agreed: true };
      await expect((controller[method] as any)('11111111-1111-4111-8111-111111111111',
        body, method.includes('Declare') ? technician : customer)).rejects.toMatchObject({
        response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' },
      });
      expect(finance.assertFundedCollectionReady).toHaveBeenCalledOnce();
      for (const [key, value] of Object.entries(finance)) {
        if (key !== 'assertFundedCollectionReady') expect(value).not.toHaveBeenCalled();
      }
    });
  it.each([
    ['soloWallet', 'payInvoiceWithWallet', 'invoice-1', customer],
    ['soloVnpay', 'createVnpayPaymentUrl', 'invoice-1', customer],
    ['visitWallet', 'payVisitWithWallet', 'group-1', customer],
    ['visitVnpay', 'createVisitVnpayUrl', 'group-1', customer],
  ] as const)('%s passes only the opaque reservation and authenticated actor', async (method, serviceMethod, id, req) => {
    const { finance, controller } = setup();
    const response = await (controller[method] as any)(id, { voucherReservationId: reservationId }, req);
    expect(response).toHaveProperty('data');
    expect(finance[serviceMethod]).toHaveBeenCalledWith(id, req.user,
      ...(serviceMethod.toLowerCase().includes('vnpay') ? [req.ip, 'web', undefined] : []), reservationId);
  });

  it.each([
    ['soloCashDeclare', 'declareCashSettlement', 'order-1'],
    ['visitCashDeclare', 'declareVisitCash', 'group-1'],
  ] as const)('%s passes technician cash declaration and reservation', async (method, serviceMethod, id) => {
    const { finance, controller } = setup();
    const body = { voucherReservationId: reservationId, declaredAmount: 50000 };
    await (controller[method] as any)(id, body, technician);
    expect(finance[serviceMethod]).toHaveBeenCalledWith(id,
      expect.objectContaining({ declaredAmount: 50000 }), technician.user, reservationId);
  });

  it.each([
    ['soloCashConfirm', 'confirmVoucherCashByReservation', 'order-1'],
    ['visitCashConfirm', 'confirmVoucherVisitCashByReservation', 'group-1'],
  ] as const)('%s confirms without any client money field', async (method, serviceMethod, id) => {
    const { finance, controller } = setup();
    await (controller[method] as any)(id, { voucherReservationId: reservationId, agreed: true }, customer);
    expect(finance[serviceMethod]).toHaveBeenCalledWith(id, { agreed: true }, customer.user, reservationId);
  });

  it.each([
    ['soloZero', 'SOLO', 'invoice-1'],
    ['visitZero', 'VISIT_GROUP', 'group-1'],
  ] as const)('%s performs backend zero closeout without a provider', async (method, scope, id) => {
    const { finance, controller } = setup();
    await (controller[method] as any)(id, { voucherReservationId: reservationId }, customer);
    expect(finance.closeVoucherZeroDue).toHaveBeenCalledWith(scope, id, customer.user, reservationId);
    expect(finance.createVnpayPaymentUrl).not.toHaveBeenCalled();
  });

  it('rejects malformed reservation IDs and client supplied discounts and amounts', async () => {
    const badId = plainToInstance(VoucherReservationDto, { voucherReservationId: 'not-a-uuid' });
    expect((await validate(badId)).map(error => error.property)).toContain('voucherReservationId');
    expect((await validate(plainToInstance(VoucherReservationDto, {})))
      .map(error => error.property)).toContain('voucherReservationId');
    const injected = plainToInstance(VoucherReservationDto, {
      voucherReservationId: reservationId, amount: 0, discount: 100000,
    });
    expect((await validate(injected, { whitelist: true, forbidNonWhitelisted: true }))
      .map(error => error.property).sort()).toEqual(['amount', 'discount']);
    const cashInjected = plainToInstance(VoucherCashConfirmationDto, {
      voucherReservationId: reservationId, agreed: true, confirmedAmount: 50000,
    });
    expect((await validate(cashInjected, { whitelist: true, forbidNonWhitelisted: true }))
      .map(error => error.property)).toContain('confirmedAmount');
    const declaration = plainToInstance(VoucherCashDeclarationDto, {
      voucherReservationId: reservationId, declaredAmount: -1,
    });
    expect((await validate(declaration)).map(error => error.property)).toContain('declaredAmount');
  });

  it('mounts ten funded POST paths behind JWT, role and permission guards', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, FinanceModule))
      .toContain(FundedFinanceController);
    expect(Reflect.getMetadata(PATH_METADATA, FundedFinanceController)).toBe('finance/funded');
    expect(Reflect.getMetadata(GUARDS_METADATA, FundedFinanceController)).toEqual([
      JwtAuthGuard, RolesGuard, PermissionGuard,
    ]);
    const paths = {
      soloWallet: 'solo/:id/wallet', soloVnpay: 'solo/:id/vnpay',
      soloCashDeclare: 'solo/:id/cash/declare', soloCashConfirm: 'solo/:id/cash/confirm',
      soloZero: 'solo/:id/zero-closeout',
      visitWallet: 'visit-groups/:id/wallet', visitVnpay: 'visit-groups/:id/vnpay',
      visitCashDeclare: 'visit-groups/:id/cash/declare',
      visitCashConfirm: 'visit-groups/:id/cash/confirm',
      visitZero: 'visit-groups/:id/zero-closeout',
    } as const;
    for (const [method, path] of Object.entries(paths)) {
      const handler = FundedFinanceController.prototype[method as keyof typeof paths];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
        method.includes('Declare') ? Role.TECHNICIAN : Role.CUSTOMER,
      ]);
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toEqual([
        method.includes('Declare') ? 'order:update_status'
          : method.includes('Confirm') ? 'order:read_related' : 'invoice:pay_own',
      ]);
    }
  });

  it('returns 403 for a technician using a customer endpoint and an RBAC denial', async () => {
    const handler = FundedFinanceController.prototype.soloWallet;
    const context = { getHandler: () => handler, getClass: () => FundedFinanceController,
      switchToHttp: () => ({ getRequest: () => ({ user: technician.user }) }) } as unknown as ExecutionContext;
    expect(() => new RolesGuard(new Reflector()).canActivate(context)).toThrow(ForbiddenException);
    const allowedRoleContext = { ...context,
      switchToHttp: () => ({ getRequest: () => ({ user: customer.user }) }) } as ExecutionContext;
    const permission = new PermissionGuard(new Reflector(), { hasPermission: vi.fn(async () => false) } as never);
    await expect(permission.canActivate(allowedRoleContext)).rejects.toBeInstanceOf(BusinessException);
  });

  it('returns 401 when JWT authentication has no user', () => {
    expect(() => (new JwtAuthGuard() as any).handleRequest(null, null, null, null))
      .toThrow(UnauthorizedException);
  });

  it('propagates an ownership denial without creating a funded payment', async () => {
    const { finance, controller } = setup();
    finance.payInvoiceWithWallet.mockRejectedValueOnce(new BusinessException(
      ErrorCodes.OWNERSHIP_DENIED, 'Invoice not found'));
    await expect(controller.soloWallet('invoice-1', { voucherReservationId: reservationId }, customer))
      .rejects.toBeInstanceOf(BusinessException);
    expect(finance.createVnpayPaymentUrl).not.toHaveBeenCalled();
  });
});
