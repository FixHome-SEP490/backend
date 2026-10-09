import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerWallet } from './entities/customer-wallet.entity';
import { CustomerWalletTransaction } from './entities/customer-wallet-transaction.entity';
import { CustomerWalletService } from './customer-wallet.service';

/** The customer wallet ledger; its HTTP routes live in FinanceModule, which owns VNPay. */
@Module({
  imports: [TypeOrmModule.forFeature([CustomerWallet, CustomerWalletTransaction])],
  providers: [CustomerWalletService],
  exports: [CustomerWalletService],
})
export class CustomerWalletModule {}
