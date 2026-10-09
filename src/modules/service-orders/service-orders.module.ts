// src/modules/service-orders/service-orders.module.ts
import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServiceOrdersController } from './service-orders.controller';
import { ServiceOrdersService } from './service-orders.service';
import { WarrantyClaimsController } from './warranty-claims.controller';
import { WarrantyClaimsService } from './warranty-claims.service';
import { WarrantyClaimsTechnicianController } from './warranty-claims-technician.controller';
import { WarrantyClaimsTechnicianService } from './warranty-claims-technician.service';
import { WarrantyClaimReadService } from './warranty-claim-read.service';
import { WarrantyClaimsManagerController } from './warranty-claims-manager.controller';
import { WarrantyClaimsManagerService } from './warranty-claims-manager.service';
import { WarrantyNotifier } from './warranty-notifier.service';
import { WarrantyVisit } from './entities/warranty-visit.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { SupportCasesModule } from '../support-cases/support-cases.module';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { OrderStatusHistory } from './entities/order-status-history.entity';
import { ArrivalCheckIn } from './entities/arrival-check-in.entity';
import { RepairEvidence } from './entities/repair-evidence.entity';
import { Cancellation } from './entities/cancellation.entity';
import { CancellationStrike } from './entities/cancellation-strike.entity';
import { Invoice } from './entities/invoice.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import { AdditionalCostRequest } from './entities/additional-cost-request.entity';
import { AdditionalCostItem } from './entities/additional-cost-item.entity';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { QuotationItem } from '../quotations/entities/quotation-item.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { CustomerServiceConfirmation } from './entities/customer-service-confirmation.entity';
import { FinanceModule } from '../finance/finance.module';
import { WalletModule } from '../wallet/wallet.module';
import { ReputationModule } from '../reputation/reputation.module';

@Module({
  imports: [
    MediaModule,
    FinanceModule,
    WalletModule,
    NotificationsModule,
    SupportCasesModule,
    ReputationModule,
    TypeOrmModule.forFeature([
      ServiceOrder,
      TechnicianAssignment,
      OrderStatusHistory,
      ArrivalCheckIn,
      RepairEvidence,
      Cancellation,
      CancellationStrike,
      Invoice,
      InvoiceItem,
      WarrantyCoverage,
      AdditionalCostRequest,
      AdditionalCostItem,
      WarrantyClaim,
      WarrantyVisit,
      Booking,
      Quotation,
      QuotationItem,
      User,
      TechnicianProfile,
      CustomerServiceConfirmation,
    ]),
  ],
  controllers: [
    ServiceOrdersController,
    WarrantyClaimsController,
    WarrantyClaimsTechnicianController,
    WarrantyClaimsManagerController,
  ],
  providers: [
    ServiceOrdersService,
    WarrantyClaimsService,
    WarrantyClaimsTechnicianService,
    WarrantyClaimsManagerService,
    WarrantyClaimReadService,
    WarrantyNotifier,
  ],
  exports: [ServiceOrdersService],
})
export class ServiceOrdersModule {}
