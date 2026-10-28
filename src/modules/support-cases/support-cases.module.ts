import { CustomerWalletModule } from '../customer-wallet/customer-wallet.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Booking } from '../bookings/entities/booking.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { SupportCasesController } from './support-cases.controller';
import { CustomerStopRequestController } from './customer-stop-request.controller';
import { SupportCasesService } from './support-cases.service';
import { SupportCase } from './entities';
import { ReputationModule } from '../reputation/reputation.module';
import { TechnicianReportService } from './technician-report.service';

@Module({
  imports: [
    AuditLogModule,
    CustomerWalletModule,
    NotificationsModule,
    ReputationModule,
    TypeOrmModule.forFeature([
      SupportCase,
      Booking,
      ServiceOrder,
      Invoice,
      CashSettlement,
      TechnicianAssignment,
    ]),
  ],
  controllers: [SupportCasesController, CustomerStopRequestController],
  providers: [SupportCasesService, TechnicianReportService],
  exports: [SupportCasesService],
})
export class SupportCasesModule {}
