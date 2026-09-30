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

  const controller = new TechnicianWalletController(
    mockWalletService,
    {} as BankAccountService,
    {} as WithdrawalPayoutService,
  );
  const mockUser = { id: 'tech-user-123' } as User;

  it('topUp generates fallback idempotencyKey if omitted and returns formatted payload', async () => {
    vi.mocked(mockWalletService.topUp).mockResolvedValue({
      wallet: { id: 'w-1', balance: 500000 } as any,
      transaction: { id: 'tx-1', balanceAfter: 500000 } as any,
    });

    const res = await controller.topUp(mockUser, { amount: 200000 }, {} as any);

    expect(mockWalletService.topUp).toHaveBeenCalledWith(
      'tech-user-123',
      200000,
      expect.stringMatching(/^TOPUP_tech-use_\d+_[a-z0-9]+$/),
    );
    expect(res).toEqual({
      success: true,
      paymentId: 'tx-1',
      paymentUrl: null,
      balanceAfter: 500000,
      message: 'Nạp tiền vào ví thành công',
    });
  });

  it('topUp honors provided idempotencyKey', async () => {
    vi.mocked(mockWalletService.topUp).mockResolvedValue({
      wallet: { id: 'w-1', balance: 700000 } as any,
      transaction: { id: 'tx-2', balanceAfter: 700000 } as any,
    });

    const res = await controller.topUp(mockUser, {
      amount: 200000,
      idempotencyKey: 'CUSTOM_KEY_123',
    }, {} as any);

    expect(mockWalletService.topUp).toHaveBeenCalledWith(
      'tech-user-123',
      200000,
      'CUSTOM_KEY_123',
    );
    expect(res.paymentId).toBe('tx-2');
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
