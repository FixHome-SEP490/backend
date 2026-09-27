import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { User } from '../users/entities/user.entity';
import { AdminWalletController } from './admin-wallet.controller';
import { Wallet, WalletTransaction, WithdrawalRequest } from './entities';
import { ServiceManagerWalletController } from './service-manager-wallet.controller';
import { SettlementService } from './settlement.service';
import { TechnicianWalletController } from './technician-wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Wallet,
      WalletTransaction,
      WithdrawalRequest,
      User,
    ]),
    SystemConfigModule,
    AuditLogModule,
    NotificationsModule,
  ],
  controllers: [
    TechnicianWalletController,
    ServiceManagerWalletController,
    AdminWalletController,
  ],
  providers: [WalletService, SettlementService],
  exports: [WalletService, SettlementService],
})
export class WalletModule {}
