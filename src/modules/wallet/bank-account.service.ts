import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { Role, VerificationStatus } from '../../shared/enums';
import {
  accountNamesMatch,
  normalizeAccountName,
} from '../../shared/utils/account-name';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TechnicianVerification } from '../technician-verifications/entities/technician-verification.entity';
import { BankAccountResponseDto, SaveBankAccountDto } from './dto';
import { TechnicianBankAccount } from './entities';
import { VN_BANKS, VnBank, findBankByBin } from './payout/vn-banks';

/**
 * The bank account a technician's withdrawals are paid to.
 *
 * The holder name must match the name frozen at KYC approval. That single
 * check is what stops a withdrawal from being routed to someone else's
 * account, so it runs here, on save, and every withdrawal then copies the
 * account that passed it.
 */
@Injectable()
export class BankAccountService {
  constructor(
    @InjectRepository(TechnicianBankAccount)
    private readonly bankAccountRepo: Repository<TechnicianBankAccount>,
    @InjectRepository(TechnicianVerification)
    private readonly verificationRepo: Repository<TechnicianVerification>,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  listBanks(): readonly VnBank[] {
    return VN_BANKS;
  }

  async getMine(technicianId: string): Promise<BankAccountResponseDto | null> {
    const account = await this.bankAccountRepo.findOne({
      where: { technicianId },
    });
    return account ? this.toResponse(account) : null;
  }

  async save(
    technicianId: string,
    dto: SaveBankAccountDto,
  ): Promise<BankAccountResponseDto> {
    const bank = findBankByBin(dto.bankBin);
    if (!bank) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Ngân hàng này chưa hỗ trợ nhận tiền rút. Vui lòng chọn ngân hàng khác trong danh sách.',
      );
    }

    const verifiedName = await this.verifiedNameOf(technicianId);
    if (!accountNamesMatch(dto.accountName, verifiedName)) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        `Tên chủ tài khoản phải trùng với tên đã xác minh danh tính: ${normalizeAccountName(verifiedName)}`,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(TechnicianBankAccount);
      const existing = await repo.findOne({
        where: { technicianId },
        lock: { mode: 'pessimistic_write' },
      });

      const next = repo.create({
        ...(existing ?? { technicianId }),
        bankBin: bank.bin,
        bankCode: bank.code,
        bankName: bank.shortName,
        accountNumber: dto.accountNumber,
        accountName: normalizeAccountName(dto.accountName),
      });
      const saved = await repo.save(next);

      // Where money goes is worth an audit trail. Only the tail of the account
      // number is logged, which is enough to tell two accounts apart.
      await this.auditLogService.logWithManager(manager, {
        actorUserId: technicianId,
        actorRole: Role.TECHNICIAN,
        action: existing ? 'BANK_ACCOUNT_UPDATED' : 'BANK_ACCOUNT_CREATED',
        resourceType: 'technician_bank_account',
        resourceId: saved.id,
        before: existing
          ? {
              bankCode: existing.bankCode,
              accountNumberTail: existing.accountNumber.slice(-4),
            }
          : undefined,
        after: {
          bankCode: saved.bankCode,
          accountNumberTail: saved.accountNumber.slice(-4),
        },
      });

      return this.toResponse(saved);
    });
  }

  /**
   * The name to match against: frozen when the KYC was approved, never the
   * live profile name, which the technician can still edit.
   */
  private async verifiedNameOf(technicianId: string): Promise<string> {
    const verification = await this.verificationRepo.findOne({
      where: { technicianId, status: VerificationStatus.VERIFIED },
      order: { reviewedAt: 'DESC' },
    });
    if (!verification) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Bạn cần được duyệt xác minh danh tính (KYC) trước khi khai báo tài khoản nhận tiền.',
      );
    }
    if (!verification.verifiedFullName?.trim()) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Hồ sơ xác minh danh tính chưa ghi nhận họ tên. Vui lòng liên hệ Quản lý dịch vụ.',
      );
    }
    return verification.verifiedFullName;
  }

  private toResponse(account: TechnicianBankAccount): BankAccountResponseDto {
    return {
      bankBin: account.bankBin,
      bankCode: account.bankCode,
      bankName: account.bankName,
      accountNumber: account.accountNumber,
      accountName: account.accountName,
      updatedAt: account.updatedAt,
    };
  }
}
