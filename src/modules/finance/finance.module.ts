import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { SupportCasesModule } from '../support-cases/support-cases.module';
import { Booking } from '../bookings/entities/booking.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { VnpayController } from './vnpay/vnpay.controller';
import { Payment } from './entities/payment.entity';
import { PlatformDue } from './entities/platform-due.entity';
import {
  PAYMENT_VERIFICATION_PORT,
} from './payment-verification.port';
import { UnconfiguredPaymentVerificationAdapter } from './unconfigured-payment-verification.adapter';

@Module({
  imports: [
    AuditLogModule,
    SupportCasesModule,
    TypeOrmModule.forFeature([
      Booking,
      TechnicianAssignment,
      CashSettlement,
      CommissionDue,
      Invoice,
      ServiceOrder,
      Payment,
      PlatformDue,
    ]),
  ],
  controllers: [FinanceController, VnpayController],
  providers: [
    FinanceService,
    UnconfiguredPaymentVerificationAdapter,
    {
      provide: PAYMENT_VERIFICATION_PORT,
      useExisting: UnconfiguredPaymentVerificationAdapter,
    },
  ],
  exports: [FinanceService],
})
export class FinanceModule {}
