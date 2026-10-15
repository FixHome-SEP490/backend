import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { TechnicianVerificationsModule } from '../technician-verifications/technician-verifications.module';
import { AdminCustomerVerificationsController } from './admin-customer-verifications.controller';
import { CustomerVerificationsController } from './customer-verifications.controller';
import { CustomerVerificationsService } from './customer-verifications.service';
import { CustomerVerificationDocument } from './entities/customer-verification-document.entity';
import { CustomerVerification } from './entities/customer-verification.entity';

/**
 * Customer identity verification (PO 14/10/2026). Reuses the private KYC
 * storage of the technician module, keyed on the user id, and nothing else
 * from it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CustomerVerification, CustomerVerificationDocument]),
    TechnicianVerificationsModule,
    NotificationsModule,
  ],
  controllers: [CustomerVerificationsController, AdminCustomerVerificationsController],
  providers: [CustomerVerificationsService],
  exports: [CustomerVerificationsService],
})
export class CustomerVerificationsModule {}
