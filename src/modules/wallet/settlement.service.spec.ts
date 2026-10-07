import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlatformDue } from '../finance/entities/platform-due.entity';
import { PlatformDueStatus } from '../../shared/enums';
import { SettlementService } from './settlement.service';
import { WalletService } from './wallet.service';
import { DataSource } from 'typeorm';
import {
  CashSettlementStatus,
  PaymentStatus,
  ServiceOrderStatus,
  WalletTransactionType,
} from '../../shared/enums';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { WalletTransaction } from './entities';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';

describe('SettlementService', () => {
  let service: SettlementService;
  let mockWalletService: Partial<WalletService>;
  let mockDataSource: Partial<DataSource>;
  let mockEntityManager: any;

  beforeEach(() => {
    mockEntityManager = {
      findOne: vi.fn(),
      find: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      update: vi.fn().mockResolvedValue({ affected: 1 }),
    };

    mockWalletService = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ id: 'wallet-1', technicianId: 'tech-1', balance: 500000n }),
      mutateBalance: vi.fn().mockResolvedValue({ id: 'tx-1', amount: 50000n }),
    };

    mockDataSource = {
      transaction: vi.fn().mockImplementation((cb) => cb(mockEntityManager)),
    };

    service = new SettlementService(
      mockWalletService as WalletService,
      mockDataSource as DataSource,
    );
  });

  it('should defer settlement if order is not COMPLETED', async () => {
    mockEntityManager.findOne.mockImplementation((entity: any) => {
      if (entity === ServiceOrder) {
        return Promise.resolve({ id: 'order-1', status: ServiceOrderStatus.UNDER_REPAIR });
      }
      return Promise.resolve(null);
    });

    const result = await service.trySettleOrder('order-1');
    expect(result.settled).toBe(false);
    expect(result.reason).toBe('ORDER_NOT_COMPLETED');
    expect(mockWalletService.mutateBalance).not.toHaveBeenCalled();
  });

  it('should defer settlement if invoice is not PAID', async () => {
    mockEntityManager.findOne.mockImplementation((entity: any) => {
      if (entity === ServiceOrder) {
        return Promise.resolve({ id: 'order-1', status: ServiceOrderStatus.COMPLETED });
      }
      if (entity === Invoice) {
        return Promise.resolve({ serviceOrderId: 'order-1', paymentStatus: PaymentStatus.UNPAID });
      }
      return Promise.resolve(null);
    });

    const result = await service.trySettleOrder('order-1');
    expect(result.settled).toBe(false);
    expect(result.reason).toBe('PAYMENT_NOT_PAID');
    expect(mockWalletService.mutateBalance).not.toHaveBeenCalled();
  });

  it('should do nothing and return settled if order already settled', async () => {
    mockEntityManager.findOne.mockImplementation((entity: any) => {
      if (entity === ServiceOrder) {
        return Promise.resolve({ id: 'order-1', status: ServiceOrderStatus.COMPLETED });
      }
      if (entity === Invoice) {
        return Promise.resolve({ serviceOrderId: 'order-1', paymentStatus: PaymentStatus.PAID });
      }
      if (entity === WalletTransaction) {
        return Promise.resolve({ id: 'tx-existing', referenceId: 'order-1' });
      }
      return Promise.resolve(null);
    });

    const result = await service.trySettleOrder('order-1');
    expect(result.settled).toBe(true);
    expect(result.reason).toBe('ALREADY_SETTLED');
    expect(mockWalletService.mutateBalance).not.toHaveBeenCalled();
  });

  it('should deduct PLATFORM_FEE for cash order', async () => {
    mockEntityManager.findOne.mockImplementation((entity: any) => {
      if (entity === ServiceOrder) {
        return Promise.resolve({ id: 'order-1', code: 'ORD001', status: ServiceOrderStatus.COMPLETED });
      }
      if (entity === Invoice) {
        return Promise.resolve({
          serviceOrderId: 'order-1',
          paymentStatus: PaymentStatus.PAID,
          commissionAmount: 50000,
          fixHomePartsTotal: 20000,
          shippingFee: 0,
        });
      }
      if (entity === WalletTransaction) {
        return Promise.resolve(null);
      }
      if (entity === TechnicianAssignment) {
        return Promise.resolve({ technicianId: 'tech-1' });
      }
      if (entity === CashSettlement) {
        return Promise.resolve({ status: CashSettlementStatus.CONFIRMED });
      }
      return Promise.resolve(null);
    });

    const result = await service.trySettleOrder('order-1');
    expect(result.settled).toBe(true);
    expect(mockWalletService.mutateBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wallet-1',
        type: WalletTransactionType.PLATFORM_FEE,
        amount: 70000,
        allowNegative: true,
      }),
    );
    // the fee was collected, so the cash PlatformDue is closed
    expect(mockEntityManager.update).toHaveBeenCalledWith(
      PlatformDue,
      { serviceOrderId: 'order-1', status: PlatformDueStatus.PENDING },
      expect.objectContaining({ status: PlatformDueStatus.SETTLED }),
    );
  });

  it('should credit ONLINE_EARNING for online paid order', async () => {
    mockEntityManager.findOne.mockImplementation((entity: any) => {
      if (entity === ServiceOrder) {
        return Promise.resolve({ id: 'order-1', code: 'ORD002', status: ServiceOrderStatus.COMPLETED });
      }
      if (entity === Invoice) {
        return Promise.resolve({
          serviceOrderId: 'order-1',
          paymentStatus: PaymentStatus.PAID,
          grandTotal: 300000,
          commissionAmount: 45000,
          fixHomePartsTotal: 50000,
          shippingFee: 0,
        });
      }
      if (entity === WalletTransaction) {
        return Promise.resolve(null);
      }
      if (entity === TechnicianAssignment) {
        return Promise.resolve({ technicianId: 'tech-1' });
      }
      if (entity === CashSettlement) {
        return Promise.resolve(null); // Not cash -> Online
      }
      return Promise.resolve(null);
    });

    const result = await service.trySettleOrder('order-1');
    expect(result.settled).toBe(true);
    // grandTotal (300k) - commission (45k) - fixHomeParts (50k) = 205k net earning
    expect(mockWalletService.mutateBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wallet-1',
        type: WalletTransactionType.ONLINE_EARNING,
        amount: 205000,
        allowNegative: false,
      }),
    );
  });
});
