import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BankAccountService } from './bank-account.service';
import { VN_BANKS } from './payout/vn-banks';
import { BusinessException } from '../../common/exceptions/business.exception';
import { VerificationStatus } from '../../shared/enums';

const TECH_ID = 'tech-1';

describe('BankAccountService', () => {
  let stored: any;
  let verification: any;
  let bankAccountRepo: any;
  let verificationRepo: any;
  let audit: { logWithManager: ReturnType<typeof vi.fn> };
  let service: BankAccountService;

  const VALID = {
    bankBin: '970436',
    accountNumber: '0123456789',
    accountName: 'NGUYEN VAN THO',
  };

  beforeEach(() => {
    stored = null;
    verification = {
      technicianId: TECH_ID,
      status: VerificationStatus.VERIFIED,
      verifiedFullName: 'Nguyễn Văn Thọ',
    };

    bankAccountRepo = {
      findOne: vi.fn(async () => (stored ? { ...stored } : null)),
      create: vi.fn((dto) => ({ ...dto })),
      save: vi.fn(async (entity) => {
        stored = { id: 'ba-1', updatedAt: new Date(), ...entity };
        return { ...stored };
      }),
    };
    verificationRepo = {
      findOne: vi.fn(async () => verification),
    };
    audit = { logWithManager: vi.fn(async () => undefined) };

    const dataSource = {
      transaction: vi.fn(async (fn: (m: unknown) => unknown) =>
        fn({ getRepository: () => bankAccountRepo }),
      ),
    };

    service = new BankAccountService(
      bankAccountRepo,
      verificationRepo,
      dataSource as never,
      audit as never,
    );
  });

  it('saves an account whose holder matches the verified KYC name', async () => {
    const saved = await service.save(TECH_ID, VALID);

    expect(saved).toMatchObject({
      bankBin: '970436',
      bankCode: 'VCB',
      bankName: 'Vietcombank',
      accountNumber: '0123456789',
      accountName: 'NGUYEN VAN THO',
    });
  });

  it('stores the holder name in bank form whatever the technician typed', async () => {
    const saved = await service.save(TECH_ID, {
      ...VALID,
      accountName: 'nguyễn  văn thọ',
    });

    expect(saved.accountName).toBe('NGUYEN VAN THO');
  });

  it('refuses a holder name that is not the verified person', async () => {
    await expect(
      service.save(TECH_ID, { ...VALID, accountName: 'TRAN THI B' }),
    ).rejects.toThrow('NGUYEN VAN THO');
    expect(bankAccountRepo.save).not.toHaveBeenCalled();
  });

  it('checks against the name frozen at KYC, not the editable profile name', async () => {
    // The technician renamed their profile to someone else's name after KYC.
    // The frozen name still says who was actually verified.
    verification.verifiedFullName = 'Nguyễn Văn Thọ';

    await expect(
      service.save(TECH_ID, { ...VALID, accountName: 'LE VAN KHAC' }),
    ).rejects.toThrow(BusinessException);
  });

  it('refuses before KYC has been approved', async () => {
    verificationRepo.findOne.mockResolvedValue(null);

    await expect(service.save(TECH_ID, VALID)).rejects.toThrow('KYC');
    expect(bankAccountRepo.save).not.toHaveBeenCalled();
  });

  it('asks only for an approved KYC', async () => {
    await service.save(TECH_ID, VALID);

    expect(verificationRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { technicianId: TECH_ID, status: VerificationStatus.VERIFIED },
      }),
    );
  });

  it('refuses when the approved KYC carries no name', async () => {
    verification.verifiedFullName = null;

    await expect(service.save(TECH_ID, VALID)).rejects.toThrow(
      'chưa ghi nhận họ tên',
    );
  });

  it('refuses a bank that cannot receive payouts', async () => {
    await expect(
      service.save(TECH_ID, { ...VALID, bankBin: '999999' }),
    ).rejects.toThrow('chưa hỗ trợ');
  });

  it('updates in place and audits only the tail of the account number', async () => {
    await service.save(TECH_ID, VALID);
    audit.logWithManager.mockClear();

    await service.save(TECH_ID, { ...VALID, accountNumber: '9876543210' });

    const [, entry] = audit.logWithManager.mock.calls[0];
    expect(entry.action).toBe('BANK_ACCOUNT_UPDATED');
    expect(entry.before).toEqual({ bankCode: 'VCB', accountNumberTail: '6789' });
    expect(entry.after).toEqual({ bankCode: 'VCB', accountNumberTail: '3210' });
    // The full number never lands in the audit log.
    expect(JSON.stringify(entry)).not.toContain('9876543210');
  });

  it('returns null when nothing has been saved yet', async () => {
    expect(await service.getMine(TECH_ID)).toBeNull();
  });

  it('offers only banks with a 6-digit BIN and no duplicates', () => {
    const banks = service.listBanks();
    expect(banks.length).toBe(VN_BANKS.length);
    expect(banks.every((b) => /^\d{6}$/.test(b.bin))).toBe(true);
    expect(new Set(banks.map((b) => b.bin)).size).toBe(banks.length);
  });
});
