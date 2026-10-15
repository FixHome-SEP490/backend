import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../../common/exceptions/business.exception';
import { Role } from '../../shared/enums';
import { CustomerBankAccountService } from './customer-bank-account.service';

const CUSTOMER_ID = 'cust-1';

describe('CustomerBankAccountService (PO 14/10/2026)', () => {
  let saved: any[];
  let audit: { logWithManager: ReturnType<typeof vi.fn> };
  let verifications: { requireVerifiedName: ReturnType<typeof vi.fn> };
  let service: CustomerBankAccountService;

  beforeEach(() => {
    saved = [];
    const repo = {
      findOne: vi.fn(async () => (saved.length ? { ...saved[saved.length - 1] } : null)),
      create: vi.fn((v: any) => ({ ...v })),
      save: vi.fn(async (v: any) => {
        const row = { id: 'acc-1', updatedAt: new Date(), ...v };
        saved.push(row);
        return row;
      }),
    };
    const dataSource = { transaction: vi.fn(async (fn: any) => fn({ getRepository: () => repo })) };
    audit = { logWithManager: vi.fn(async () => undefined) };
    verifications = { requireVerifiedName: vi.fn(async () => 'Nguyễn Văn Ân') };
    service = new CustomerBankAccountService(repo as never, dataSource as never, verifications as never, audit as never);
  });

  it('saves an account whose holder name matches the verified name, without accents, and audits the tail only', async () => {
    const result = await service.save(CUSTOMER_ID, { bankBin: '970436', accountNumber: '0123456789', accountName: 'nguyen van an' });
    expect(result).toMatchObject({ bankCode: 'VCB', bankName: 'Vietcombank', accountName: 'NGUYEN VAN AN' });
    expect(verifications.requireVerifiedName).toHaveBeenCalledWith(CUSTOMER_ID, 'bank_account');
    expect(audit.logWithManager).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'CUSTOMER_BANK_ACCOUNT_CREATED',
        actorRole: Role.CUSTOMER,
        after: { bankCode: 'VCB', accountNumberTail: '6789' },
      }),
    );
    await service.save(CUSTOMER_ID, { bankBin: '970422', accountNumber: '99887766', accountName: 'NGUYEN VAN AN' });
    expect(audit.logWithManager).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'CUSTOMER_BANK_ACCOUNT_UPDATED', before: { bankCode: 'VCB', accountNumberTail: '6789' } }),
    );
  });

  it('refuses a holder name different from the verified name', async () => {
    await expect(
      service.save(CUSTOMER_ID, { bankBin: '970436', accountNumber: '0123456789', accountName: 'TRAN THI B' }),
    ).rejects.toThrow('phải trùng với tên đã xác minh danh tính: NGUYEN VAN AN');
    expect(saved).toHaveLength(0);
  });

  it('refuses a bank that payouts cannot reach', async () => {
    await expect(
      service.save(CUSTOMER_ID, { bankBin: '999999', accountNumber: '0123456789', accountName: 'NGUYEN VAN AN' }),
    ).rejects.toThrow('chưa hỗ trợ');
  });

  it('refuses without an approved identity verification', async () => {
    verifications.requireVerifiedName.mockRejectedValueOnce(
      new BusinessException('VALIDATION_FAILED', 'Bạn cần xác minh danh tính (CCCD) trước khi khai báo tài khoản nhận tiền.'),
    );
    await expect(
      service.save(CUSTOMER_ID, { bankBin: '970436', accountNumber: '0123456789', accountName: 'NGUYEN VAN AN' }),
    ).rejects.toThrow('xác minh danh tính');
    expect(saved).toHaveLength(0);
  });
});
