import 'reflect-metadata';
import { MODULE_METADATA, PATH_METADATA, METHOD_METADATA, GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from './finance.service';
import { FinanceModule } from './finance.module';
import {
  AdminManualBankController,
  ConfirmManualBankTransferDto,
  ManualBankController,
} from './manual-bank.controller';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Payment } from './entities/payment.entity';
import { PERMISSION_KEY, ROLES_KEY } from '../../common/decorators';
import { JwtAuthGuard, PermissionGuard, RolesGuard } from '../../common/guards';
import { PaymentAttemptStatus, PaymentMode, PaymentPurpose, PaymentStatus, Role } from '../../shared/enums';

const invoiceId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const customerId = '33333333-3333-4333-8333-333333333333';
const adminId = '44444444-4444-4444-8444-444444444444';

type FixtureOptions = { shippingPolicyVersion?: 'LEGACY_100_0' | 'W3_70_30_V1'; w3Verified?: boolean };

function fixture(options: FixtureOptions = {}) {
  const w3 = options.shippingPolicyVersion === 'W3_70_30_V1';
  const invoice: Record<string, any> = {
    id: invoiceId, serviceOrderId: orderId, grandTotal: 221_000,
    paymentStatus: PaymentStatus.UNPAID, paidAt: null,
    shippingPolicyVersion: w3 ? 'W3_70_30_V1' : 'LEGACY_100_0',
    shippingFee: w3 ? 30_000 : 0,
    customerShippingShare: w3 ? 21_000 : null,
    technicianShippingShare: w3 ? 9_000 : null,
    shippingShipments: w3 ? [{
      partRequestId: '55555555-5555-4555-8555-555555555555',
      additionalCostId: '66666666-6666-4666-8666-666666666666',
      termsVersion: 1, receiptVersion: 1, shippingPolicyVersion: 'W3_70_30_V1',
      shippingFee: 30_000, customerShippingShare: 21_000, technicianShippingShare: 9_000,
    }] : null,
    laborTotal: 200_000, partsTotal: 0, fixHomePartsTotal: 0, technicianPartsTotal: 0,
    technicianPartWarrantyFeeTotal: 0, commissionAmount: 20_000,
  };
  const order: Record<string, any> = {
    id: orderId, bookingId: 'booking', status: 'under_repair',
    paymentStatus: PaymentStatus.UNPAID, completionRequestedAt: new Date(),
  };
  const booking: Record<string, any> = { id: 'booking', customerId, visitGroupId: null };
  const payments: Record<string, any>[] = [];
  let nextId = 1;
  const manager: Record<string, any> = {
    findOne: vi.fn(async (entity: any, opts: any) => {
      if (entity === Invoice) return invoice;
      if (entity === ServiceOrder) return order;
      if (entity === Booking) return booking;
      if (entity === Payment) {
        if (opts?.where?.idempotencyKey)
          return payments.find(row => row.idempotencyKey === opts.where.idempotencyKey) ?? null;
        if (opts?.where?.id) return payments.find(row => row.id === opts.where.id) ?? null;
        if (opts?.where?.providerReference)
          return payments.find(row => row.providerReference === opts.where.providerReference) ?? null;
        return null;
      }
      throw new Error('Unexpected findOne');
    }),
    find: vi.fn(async (entity: any, opts: any) => {
      if (entity !== Payment) return [];
      return payments.filter(row => !opts?.where?.invoiceId || row.invoiceId === opts.where.invoiceId);
    }),
    query: vi.fn(async () => [{ verified: options.w3Verified ?? true }]),
    create: vi.fn((_entity: any, value: any) => ({ id: `manual-payment-${nextId++}`, ...value })),
    save: vi.fn(async (entity: any, value: any) => {
      if (entity === Invoice) { Object.assign(invoice, value); return value; }
      if (entity === ServiceOrder) { Object.assign(order, value); return value; }
      if (entity === Payment) {
        const index = payments.findIndex(row => row.id === value.id);
        if (index >= 0) payments[index] = value; else payments.push(value);
        return value;
      }
      throw new Error('Unexpected save');
    }),
  };
  const service: any = Object.create(FinanceService.prototype);
  service.dataSource = {
    transaction: async (fn: (m: any) => any) => {
      const invoiceState = { ...invoice };
      const orderState = { ...order };
      const paymentState = payments.map(row => ({ ...row }));
      try {
        return await fn(manager);
      } catch (error) {
        for (const key of Object.keys(invoice)) if (!(key in invoiceState)) delete invoice[key];
        Object.assign(invoice, invoiceState);
        for (const key of Object.keys(order)) if (!(key in orderState)) delete order[key];
        Object.assign(order, orderState);
        payments.splice(0, payments.length, ...paymentState.map(row => ({ ...row })));
        throw error;
      }
    },
  };
  service.auditLogService = {
    logWithManager: vi.fn().mockResolvedValue(undefined),
    logWithManagerStrict: vi.fn().mockResolvedValue(undefined),
  };
  service.assertNoActiveCashIntent = vi.fn().mockResolvedValue(undefined);
  service.assertNewCollectionAllowed = vi.fn().mockResolvedValue(undefined);
  service.assertNoStoppedCollection = vi.fn().mockResolvedValue(undefined);
  service.closeAbandonedVnpayAttempts = vi.fn().mockResolvedValue(undefined);
  service.markInvoicePaidOnline = vi.fn(async (_manager: any, target: Record<string, any>) => {
    target.paymentStatus = PaymentStatus.PAID;
    target.paidAt = new Date();
  });
  return { service, manager, invoice, order, booking, payments };
}

describe('manual bank payment for capstone, verified by Admin only', () => {
  it('opens a pending attempt without marking invoice paid or posting technician wallet', async () => {
    const f = fixture();
    const opened = await f.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER });
    expect(opened).toMatchObject({ invoiceId, amount: 221_000, status: PaymentAttemptStatus.PENDING });
    expect(f.invoice.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(f.payments[0]).toMatchObject({
      provider: 'manual_bank', mode: PaymentMode.LIVE, purpose: PaymentPurpose.INVOICE,
      status: PaymentAttemptStatus.PENDING, requestedByUserId: customerId,
    });
    expect(f.service.markInvoicePaidOnline).not.toHaveBeenCalled();
    // A replay must not depend on collection exclusivity that may have changed since selection.
    f.service.assertNewCollectionAllowed.mockRejectedValueOnce(new Error('voucher took the invoice'));
    f.service.assertNoActiveCashIntent.mockRejectedValueOnce(new Error('cash intent exists'));
    expect(await f.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER })).toEqual(opened);
    expect(f.payments).toHaveLength(1);
    expect(f.service.markInvoicePaidOnline).not.toHaveBeenCalled();
  });

  it('refuses nonowners, non-Admin verification and grouped invoices', async () => {
    const f = fixture();
    await expect(f.service.requestManualBankTransfer(invoiceId, { id: adminId, role: Role.CUSTOMER })).rejects.toThrow();
    f.booking.visitGroupId = 'some-group';
    await expect(f.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER })).rejects.toThrow();
    f.booking.visitGroupId = null;
    await f.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER });
    await expect(f.service.confirmManualBankTransfer(invoiceId,
      { amount: 221_000, bankReference: 'FT20261107001' }, { id: customerId, role: Role.CUSTOMER })).rejects.toThrow();
    expect(f.invoice.paymentStatus).toBe(PaymentStatus.UNPAID);
  });

  it('only Admin confirms exact observed amount and a unique bank reference; replays are harmless', async () => {
    const f = fixture();
    await f.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER });
    await expect(f.service.confirmManualBankTransfer(invoiceId, { amount: 221_001, bankReference: 'FT20261107001' },
      { id: adminId, role: Role.ADMIN })).rejects.toThrow();
    expect(f.invoice.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(f.service.markInvoicePaidOnline).not.toHaveBeenCalled();
    const confirmation = await f.service.confirmManualBankTransfer(invoiceId,
      { amount: 221_000, bankReference: ' FT20261107001 ' }, { id: adminId, role: Role.ADMIN });
    expect(confirmation).toMatchObject({ invoiceId, amount: 221_000, status: PaymentAttemptStatus.VERIFIED });
    expect(f.payments[0]).toMatchObject({
      providerReference: 'MANUAL_BANK:FT20261107001', status: PaymentAttemptStatus.VERIFIED,
    });
    expect(f.service.markInvoicePaidOnline).toHaveBeenCalledTimes(1);
    expect(f.service.auditLogService.logWithManagerStrict).toHaveBeenCalledTimes(1);
    expect(f.service.auditLogService.logWithManagerStrict).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ action: 'MANUAL_BANK_TRANSFER_VERIFIED', actorUserId: adminId }),
    );
    expect(await f.service.confirmManualBankTransfer(invoiceId,
      { amount: 221_000, bankReference: 'FT20261107001' }, { id: adminId, role: Role.ADMIN })).toEqual(confirmation);
    expect(await f.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER }))
      .toEqual(confirmation);
    expect(f.service.markInvoicePaidOnline).toHaveBeenCalledTimes(1);
    expect(f.service.auditLogService.logWithManagerStrict).toHaveBeenCalledTimes(1);
    await expect(f.service.confirmManualBankTransfer(invoiceId,
      { amount: 221_000, bankReference: 'FT20261107002' }, { id: adminId, role: Role.ADMIN })).rejects.toThrow();
    expect(f.service.markInvoicePaidOnline).toHaveBeenCalledTimes(1);
  });

  it('blocks a new selection while cash or another pending rail owns the invoice', async () => {
    const cash = fixture();
    cash.service.assertNoActiveCashIntent.mockRejectedValueOnce(new Error('cash intent pending'));
    await expect(cash.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER }))
      .rejects.toThrow();
    expect(cash.payments).toHaveLength(0);

    const vnpay = fixture();
    vnpay.payments.push({
      id: 'vnpay-pending', invoiceId, purpose: PaymentPurpose.INVOICE, provider: 'vnpay',
      mode: PaymentMode.LIVE, status: PaymentAttemptStatus.PENDING, amount: 221_000,
    });
    await expect(vnpay.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER }))
      .rejects.toThrow();
    expect(vnpay.payments).toHaveLength(1);
  });

  it('does not settle if a voucher or interruption appears after the customer selected bank', async () => {
    const f = fixture();
    await f.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER });
    f.service.assertNewCollectionAllowed.mockRejectedValueOnce(new Error('voucher reservation exists'));
    await expect(f.service.confirmManualBankTransfer(invoiceId,
      { amount: 221_000, bankReference: 'FT20261107001' }, { id: adminId, role: Role.ADMIN })).rejects.toThrow();
    expect(f.invoice.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(f.service.markInvoicePaidOnline).not.toHaveBeenCalled();
  });

  it('cancels a concurrent pending VNPay attempt before settling the verified bank receipt', async () => {
    const f = fixture();
    await f.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER });
    f.payments.push({
      id: 'vnpay-pending', invoiceId, purpose: PaymentPurpose.INVOICE, provider: 'vnpay',
      mode: PaymentMode.LIVE, status: PaymentAttemptStatus.PENDING, amount: 221_000,
    });
    await f.service.confirmManualBankTransfer(invoiceId,
      { amount: 221_000, bankReference: 'FT20261107001' }, { id: adminId, role: Role.ADMIN });
    expect(f.payments.find(row => row.id === 'vnpay-pending'))
      .toMatchObject({ status: PaymentAttemptStatus.CANCELLED, failureCode: 'PAID_BY_MANUAL_BANK' });
    expect(f.service.markInvoicePaidOnline).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused bank reference and different reference on confirmation replay', async () => {
    const reused = fixture();
    reused.payments.push({
      id: 'other-invoice-payment', invoiceId: 'other-invoice', purpose: PaymentPurpose.INVOICE,
      provider: 'manual_bank', mode: PaymentMode.LIVE, status: PaymentAttemptStatus.VERIFIED,
      amount: 100_000, providerReference: 'MANUAL_BANK:FT20261107001',
    });
    await reused.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER });
    await expect(reused.service.confirmManualBankTransfer(invoiceId,
      { amount: 221_000, bankReference: 'FT20261107001' }, { id: adminId, role: Role.ADMIN })).rejects.toThrow();
    expect(reused.invoice.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(reused.service.markInvoicePaidOnline).not.toHaveBeenCalled();
  });

  it('rolls the settlement back when the strict audit insert fails', async () => {
    const f = fixture();
    await f.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER });
    f.service.auditLogService.logWithManagerStrict.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(f.service.confirmManualBankTransfer(invoiceId,
      { amount: 221_000, bankReference: 'FT20261107001' }, { id: adminId, role: Role.ADMIN })).rejects.toThrow();
    expect(f.invoice.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(f.payments[0]).toMatchObject({ status: PaymentAttemptStatus.PENDING, providerReference: null });
  });

  it('keeps the existing invoice eligibility gate: legacy works, invalid W3 does not', async () => {
    const legacy = fixture();
    await expect(legacy.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER }))
      .resolves.toMatchObject({ status: PaymentAttemptStatus.PENDING });

    const w3 = fixture({ shippingPolicyVersion: 'W3_70_30_V1', w3Verified: false });
    await expect(w3.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER }))
      .rejects.toThrow();
    expect(w3.payments).toHaveLength(0);
    expect(w3.manager.query).toHaveBeenCalledTimes(1);

    const verified = fixture({ shippingPolicyVersion: 'W3_70_30_V1', w3Verified: true });
    await expect(verified.service.requestManualBankTransfer(invoiceId, { id: customerId, role: Role.CUSTOMER }))
      .resolves.toMatchObject({ status: PaymentAttemptStatus.PENDING });
    expect(verified.manager.query).toHaveBeenCalledTimes(1);
  });
});

describe('manual bank API contract', () => {
  it('mounts customer selection and Admin confirmation behind JWT, role and DB permission guards', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, FinanceModule))
      .toEqual(expect.arrayContaining([ManualBankController, AdminManualBankController]));

    expect(Reflect.getMetadata(PATH_METADATA, ManualBankController)).toBe('finance/manual-bank');
    expect(Reflect.getMetadata(GUARDS_METADATA, ManualBankController))
      .toEqual([JwtAuthGuard, RolesGuard, PermissionGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, ManualBankController)).toEqual([Role.CUSTOMER]);
    expect(Reflect.getMetadata(PERMISSION_KEY, ManualBankController)).toEqual(['invoice:pay_own']);
    expect(Reflect.getMetadata(PATH_METADATA, ManualBankController.prototype.request)).toBe(':invoiceId');
    expect(Reflect.getMetadata(METHOD_METADATA, ManualBankController.prototype.request)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ManualBankController.prototype.request)).toBe(200);

    expect(Reflect.getMetadata(PATH_METADATA, AdminManualBankController)).toBe('admin/payments/manual-bank');
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminManualBankController))
      .toEqual([JwtAuthGuard, RolesGuard, PermissionGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminManualBankController)).toEqual([Role.ADMIN]);
    expect(Reflect.getMetadata(PERMISSION_KEY, AdminManualBankController)).toEqual(['invoice:read_related']);
    expect(Reflect.getMetadata(PATH_METADATA, AdminManualBankController.prototype.confirm)).toBe(':invoiceId/confirm');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminManualBankController.prototype.confirm)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, AdminManualBankController.prototype.confirm)).toBe(200);
  });

  it('accepts only a whole positive VND amount and a bounded bank reference', async () => {
    const valid = Object.assign(new ConfirmManualBankTransferDto(), {
      amount: 221_000, bankReference: 'FT20261107001',
    });
    expect(await validate(valid)).toHaveLength(0);
    const invalid = Object.assign(new ConfirmManualBankTransferDto(), { amount: 221_000.5, bankReference: 'short' });
    expect((await validate(invalid)).map(error => error.property).sort()).toEqual(['amount', 'bankReference']);
  });
});
