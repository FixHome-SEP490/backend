import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { FinanceModule } from '../finance/finance.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { TechnicianVerification } from '../technician-verifications/entities/technician-verification.entity';
import { User } from '../users/entities/user.entity';
import { AdminWalletController } from './admin-wallet.controller';
import { BankAccountService } from './bank-account.service';
import {
  TechnicianBankAccount,
  Wallet,
  WalletTransaction,
  WithdrawalRequest,
} from './entities';
import { payoutProviderFactory } from './payout/payout-provider.factory';
import { ServiceManagerWalletController } from './service-manager-wallet.controller';
import { SettlementService } from './settlement.service';
import { TechnicianWalletController } from './technician-wallet.controller';
import { WalletService } from './wallet.service';
import { WithdrawalPayoutService } from './withdrawal-payout.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Wallet,
      WalletTransaction,
      WithdrawalRequest,
      TechnicianBankAccount,
      TechnicianVerification,
      User,
    ]),
    SystemConfigModule,
    AuditLogModule,
    NotificationsModule,
    forwardRef(() => FinanceModule),
  ],
  controllers: [
    TechnicianWalletController,
    ServiceManagerWalletController,
    AdminWalletController,
  ],
  providers: [
    WalletService,
    SettlementService,
    BankAccountService,
    WithdrawalPayoutService,
    payoutProviderFactory,
  ],
  exports: [WalletService, SettlementService],
})
export class WalletModule {}
