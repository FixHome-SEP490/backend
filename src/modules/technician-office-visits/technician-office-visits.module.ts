import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianSkillVerification } from '../technicians/entities/technician-skill-verification.entity';
import { TechnicianVerification } from '../technician-verifications/entities/technician-verification.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { OfficeVisit } from './entities/office-visit.entity';
import { VisitOffice } from './entities/visit-office.entity';
import {
  AdminOfficeVisitsController,
  AdminProfileReviewsController,
  AdminVisitOfficesController,
  TechnicianOfficeVisitController,
} from './office-visit.controllers';
import { OfficeVisitsService } from './office-visits.service';
import { ProfileReviewService } from './profile-review.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([VisitOffice, OfficeVisit, TechnicianProfile, TechnicianSkill, TechnicianSkillVerification, TechnicianVerification, Wallet]),
    NotificationsModule,
  ],
  controllers: [TechnicianOfficeVisitController, AdminVisitOfficesController, AdminOfficeVisitsController, AdminProfileReviewsController],
  providers: [OfficeVisitsService, ProfileReviewService],
  exports: [OfficeVisitsService],
})
export class TechnicianOfficeVisitsModule {}
