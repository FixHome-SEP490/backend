// src/modules/service-orders/service-orders.module.ts
import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { FaceMatchModule } from '../face-match/face-match.module';
import { TechnicianVerificationsModule } from '../technician-verifications/technician-verifications.module';
import { CheckinFaceService } from './checkin-face.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServiceOrdersController } from './service-orders.controller';
import { ServiceOrdersService } from './service-orders.service';
import { WarrantyClaimsController } from './warranty-claims.controller';
import { WarrantyClaimsService } from './warranty-claims.service';
import { WarrantyClaimsTechnicianController } from './warranty-claims-technician.controller';
import { WarrantyClaimsTechnicianService } from './warranty-claims-technician.service';
import { WarrantyClaimReadService } from './warranty-claim-read.service';
import { WarrantyClaimDetailService } from './warranty-claim-detail.service';
import { WarrantyClaimsManagerController } from './warranty-claims-manager.controller';
import { WarrantyClaimsManagerService } from './warranty-claims-manager.service';
import { WarrantyNotifier } from './warranty-notifier.service';
import { WarrantyCostService } from './warranty-cost.service';
import { WarrantySweepService } from './warranty-sweep.service';
import { PartRequestsModule } from '../part-requests/part-requests.module';
import { CustomerWalletModule } from '../customer-wallet/customer-wallet.module';
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
import { VouchersModule } from '../vouchers/vouchers.module';

@Module({
  imports: [
    MediaModule,
    FaceMatchModule,
    TechnicianVerificationsModule,
    FinanceModule,
    WalletModule,
    NotificationsModule,
    SupportCasesModule,
    ReputationModule,
    VouchersModule,
    PartRequestsModule,
    CustomerWalletModule,
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
    CheckinFaceService,
    ServiceOrdersService,
    WarrantyClaimsService,
    WarrantyClaimsTechnicianService,
    WarrantyClaimsManagerService,
    WarrantyClaimReadService,
    WarrantyClaimDetailService,
    WarrantyNotifier,
    WarrantyCostService,
    WarrantySweepService,
  ],
  exports: [ServiceOrdersService],
})
export class ServiceOrdersModule {}
