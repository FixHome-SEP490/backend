import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { SettlementService } from './settlement.service';
import { WalletService } from './wallet.service';
import { PartCustody } from '../part-requests/entities/part-custody.entity';
import { CustodyPayout } from './entities/custody-payout.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { WalletTransaction } from './entities/wallet-transaction.entity';
import { User } from '../users/entities/user.entity';
import { PaymentStatus, ServiceOrderStatus } from '../../shared/enums';

describe('P1 component settlement (mock storage, not concurrency proof)', () => {
  let service: SettlementService;
  let db: any;
  let wallet: any;
  let rows: any[];
  let payouts: any[];
  let outstanding: number;
  let legacyTx: boolean;
  beforeEach(() => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'true');
    outstanding = 1; legacyTx = false; payouts = [];
    rows = [{ technicianId: 'tech', state: { outstandingQty: 1 } }];
    db = {
      findOne: vi.fn(async (entity, opts) => {
        if (entity === ServiceOrder) return { id: 'order', code: 'ORDER', status: ServiceOrderStatus.COMPLETED };
        if (entity === Invoice) return { id: 'invoice', paymentStatus: PaymentStatus.PAID, laborTotal: 1000, commissionAmount: 100, grandTotal: 1700, fixHomePartsTotal: 300, shippingFee: 200 };
        if (entity === TechnicianAssignment) return { technicianId: 'tech' };
        if (entity === User) return { id: 'tech' };
        if (entity === WalletTransaction) return legacyTx ? { id: 'legacy' } : null;
        if (entity === CustodyPayout) return payouts.find(p => p.component === opts.where.component) ?? null;
        if (entity === PartCustody) return rows[0];
        return null;
      }),
      find: vi.fn(async entity => entity === PartCustody ? rows.map(row => ({ ...row, state: { outstandingQty: outstanding } })) : []),
      query: vi.fn().mockResolvedValue([]),
      insert: vi.fn(async (entity, value) => { if (entity === CustodyPayout) payouts.push(value); }),
      save: vi.fn(), update: vi.fn(),
    };
    wallet = { getOrCreateWallet: vi.fn().mockResolvedValue({ id: 'wallet' }), mutateBalance: vi.fn().mockResolvedValue({ transaction: { id: 'tx' } }) };
    service = new SettlementService(wallet as WalletService, { transaction: async cb => cb(db) } as unknown as DataSource);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('credits only nonlabor while full net labor L-C is held, then releases exactly once across callbacks and sweep retries', async () => {
    expect(await service.trySettleOrder('order')).toEqual({ settled: false, reason: 'PART_RETURN_OUTSTANDING' });
    expect(wallet.mutateBalance.mock.calls.map(([v]) => v.amount)).toEqual([200]);
    await service.trySettleOrder('order', db); // callback retry
    expect(wallet.mutateBalance).toHaveBeenCalledTimes(1);
    outstanding = 0;
    expect(await service.trySettleOrder('order')).toMatchObject({ settled: true });
    await service.trySettleOrder('order'); // sweep retry
    expect(wallet.mutateBalance.mock.calls.map(([v]) => v.amount)).toEqual([200, 900]);
    expect(payouts.map(p => p.component)).toEqual(['NONLABOR', 'NET_LABOR']);
    expect(new Set(wallet.mutateBalance.mock.calls.map(([v]) => v.idempotencyKey)).size).toBe(2);
  });
  it('refuses to mix a P1 component payout with a legacy whole-order transaction', async () => {
    legacyTx = true;
    expect(await service.trySettleOrder('order')).toEqual({ settled: false, reason: 'P1_LEGACY_LEDGER_CONFLICT' });
    expect(wallet.mutateBalance).not.toHaveBeenCalled();
  });
  it('leaves older paid orders on the original settlement and key', async () => {
    rows = [];
    await service.trySettleOrder('order');
    expect(wallet.mutateBalance).toHaveBeenCalledWith(expect.objectContaining({ amount: 1100, idempotencyKey: 'ONLINE_EARNING:ORDER_order', referenceType: 'SERVICE_ORDER' }));
    expect(payouts).toHaveLength(0);
  });
  it('flag OFF never reads custody or writes component payouts', async () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'false');
    await service.trySettleOrder('order');
    expect(db.find.mock.calls.some(([entity]) => entity === PartCustody)).toBe(false);
    expect(payouts).toHaveLength(0);
  });
});
