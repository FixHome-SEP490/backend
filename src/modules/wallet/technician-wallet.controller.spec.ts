import { describe, expect, it, vi } from 'vitest';
import { TechnicianWalletController } from './technician-wallet.controller';
import { WalletService } from './wallet.service';
import { BankAccountService } from './bank-account.service';
import { WithdrawalPayoutService } from './withdrawal-payout.service';
import { User } from '../users/entities/user.entity';

describe('TechnicianWalletController', () => {
  const mockWalletService = {
    getWalletSummary: vi.fn(),
    listTransactions: vi.fn(),
    topUp: vi.fn(),
    requestWithdrawal: vi.fn(),
    listMyWithdrawals: vi.fn(),
  } as unknown as WalletService;

  const mockUser = { id: 'tech-user-123' } as User;

  it.each([['DEMO'], ['nothing configured']])('refuses a top-up and credits nothing when the payment mode is %s (no simulated money)', async (mode) => {
    const controllerWithoutGateway = new TechnicianWalletController(
      mockWalletService,
      {} as BankAccountService,
      {} as WithdrawalPayoutService,
      (mode === 'DEMO' ? { getPaymentMode: vi.fn().mockResolvedValue('DEMO') } : undefined) as never,
    );
    await expect(controllerWithoutGateway.topUp(mockUser, { amount: 200000 }, {} as any)).rejects.toThrow('Nạp tiền chưa mở');
    expect(mockWalletService.topUp).not.toHaveBeenCalled();
  });

  it('topUp initiates VNPay transaction when mode is LIVE', async () => {
    const mockFinanceService = {
      getPaymentMode: vi.fn().mockResolvedValue('LIVE'),
      createWalletTopUpVnpayUrl: vi.fn().mockResolvedValue({
        paymentId: 'pay-vnp-1',
        paymentUrl: 'https://sandbox.vnpayment.vn/pay?test=1',
      }),
    } as any;

    const liveController = new TechnicianWalletController(
      mockWalletService,
      {} as BankAccountService,
    {} as WithdrawalPayoutService,
      mockFinanceService,
    );
    const res = await liveController.topUp(
      mockUser,
      { amount: 500000, idempotencyKey: 'IDEMP_VNP_99' },
      { ip: '1.2.3.4', headers: { 'x-client-platform': 'mobile' } } as any,
    );

    expect(mockFinanceService.createWalletTopUpVnpayUrl).toHaveBeenCalledWith(
      'tech-user-123',
      500000,
      '1.2.3.4',
      'IDEMP_VNP_99',
      'mobile',
    );
    expect(res).toEqual({
      success: true,
      paymentId: 'pay-vnp-1',
      paymentUrl: 'https://sandbox.vnpayment.vn/pay?test=1',
      balanceAfter: null,
      message: 'Khởi tạo cổng thanh toán VNPay thành công',
    });
  });
});
