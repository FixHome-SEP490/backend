import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerWallet } from './entities/customer-wallet.entity';
import { CustomerWalletTransaction } from './entities/customer-wallet-transaction.entity';
import { CustomerWalletService } from './customer-wallet.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminCustomerWalletsController } from './admin-customer-wallets.controller';
import { AdminCustomerWalletsService } from './admin-customer-wallets.service';

/** The customer wallet ledger; the customer routes live in FinanceModule (VNPay), the admin ones here. */
@Module({
  imports: [TypeOrmModule.forFeature([CustomerWallet, CustomerWalletTransaction]), AuditLogModule, NotificationsModule],
  controllers: [AdminCustomerWalletsController],
  providers: [CustomerWalletService, AdminCustomerWalletsService],
  exports: [CustomerWalletService],
})
export class CustomerWalletModule {}
