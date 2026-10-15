import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { Role } from '../../shared/enums';
import { accountNamesMatch, normalizeAccountName } from '../../shared/utils/account-name';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CustomerVerificationsService } from '../customer-verifications/customer-verifications.service';
import { BankAccountResponseDto, SaveBankAccountDto } from './dto';
import { CustomerBankAccount } from './entities';
import { VN_BANKS, VnBank, findBankByBin } from './payout/vn-banks';

/**
 * The bank account a customer's withdrawals are paid to (PO 14/10/2026),
 * under the technician rules: an approved identity check first, and a holder
 * name equal to the name frozen at that approval.
 */
@Injectable()
export class CustomerBankAccountService {
  constructor(
    @InjectRepository(CustomerBankAccount)
    private readonly bankAccountRepo: Repository<CustomerBankAccount>,
    private readonly dataSource: DataSource,
    private readonly verifications: CustomerVerificationsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  listBanks(): readonly VnBank[] {
    return VN_BANKS;
  }

  async findMine(customerId: string): Promise<CustomerBankAccount | null> {
    return this.bankAccountRepo.findOne({ where: { customerId } });
  }

  async getMine(customerId: string): Promise<BankAccountResponseDto | null> {
    const account = await this.findMine(customerId);
    return account ? toBankAccountResponse(account) : null;
  }

  async save(customerId: string, dto: SaveBankAccountDto): Promise<BankAccountResponseDto> {
    const verifiedName = await this.verifications.requireVerifiedName(customerId, 'bank_account');

    const bank = findBankByBin(dto.bankBin);
    if (!bank) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Ngân hàng này chưa hỗ trợ nhận tiền rút. Vui lòng chọn ngân hàng khác trong danh sách.',
      );
    }
    if (!accountNamesMatch(dto.accountName, verifiedName)) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        `Tên chủ tài khoản phải trùng với tên đã xác minh danh tính: ${normalizeAccountName(verifiedName)}`,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CustomerBankAccount);
      const existing = await repo.findOne({
        where: { customerId },
        lock: { mode: 'pessimistic_write' },
      });
      const saved = await repo.save(
        repo.create({
          ...(existing ?? { customerId }),
          bankBin: bank.bin,
          bankCode: bank.code,
          bankName: bank.shortName,
          accountNumber: dto.accountNumber,
          accountName: normalizeAccountName(dto.accountName),
        }),
      );

      // Only the tail of the account number goes into the audit trail.
      await this.auditLogService.logWithManager(manager, {
        actorUserId: customerId,
        actorRole: Role.CUSTOMER,
        action: existing ? 'CUSTOMER_BANK_ACCOUNT_UPDATED' : 'CUSTOMER_BANK_ACCOUNT_CREATED',
        resourceType: 'customer_bank_account',
        resourceId: saved.id,
        before: existing
          ? { bankCode: existing.bankCode, accountNumberTail: existing.accountNumber.slice(-4) }
          : undefined,
        after: { bankCode: saved.bankCode, accountNumberTail: saved.accountNumber.slice(-4) },
      });

      return toBankAccountResponse(saved);
    });
  }
}

export function toBankAccountResponse(account: CustomerBankAccount): BankAccountResponseDto {
  return {
    bankBin: account.bankBin,
    bankCode: account.bankCode,
    bankName: account.bankName,
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    updatedAt: account.updatedAt,
  };
}
