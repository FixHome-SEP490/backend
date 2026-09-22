// src/modules/technician-verifications/technician-verifications.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TechnicianVerificationsController } from './technician-verifications.controller';
import { AdminTechnicianVerificationsController } from './admin-technician-verifications.controller';
import { TechnicianVerificationsService } from './technician-verifications.service';
import { TechnicianVerification } from './entities/technician-verification.entity';
import { VerificationDocument } from './entities/verification-document.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { KycStorageService } from './kyc-storage.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TechnicianVerification,
      VerificationDocument,
      TechnicianProfile,
    ]),
  ],
  controllers: [
    TechnicianVerificationsController,
    AdminTechnicianVerificationsController,
  ],
  providers: [TechnicianVerificationsService, KycStorageService],
  exports: [TechnicianVerificationsService, KycStorageService, TypeOrmModule],
})
export class TechnicianVerificationsModule {}
