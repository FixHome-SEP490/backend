import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { Booking } from '../bookings/entities/booking.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { SupportCasesController } from './support-cases.controller';
import { SupportCasesService } from './support-cases.service';
import { SupportCase } from './entities';

@Module({
  imports: [
    AuditLogModule,
    TypeOrmModule.forFeature([
      SupportCase,
      Booking,
      ServiceOrder,
      Invoice,
      CashSettlement,
      TechnicianAssignment,
    ]),
  ],
  controllers: [SupportCasesController],
  providers: [SupportCasesService],
  exports: [SupportCasesService],
})
export class SupportCasesModule {}
