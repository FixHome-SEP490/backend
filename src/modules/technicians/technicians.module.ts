// src/modules/technicians/technicians.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TechniciansController } from './technicians.controller';
import { TechniciansService } from './technicians.service';
import { TechnicianOnboardingController } from './technician-onboarding.controller';
import { TechnicianOnboardingService } from './technician-onboarding.service';
import {
  TechnicianProfile,
  TechnicianSkill,
  TechnicianSkillVerification,
  TechnicianServiceArea,
  TechnicianSchedule,
  TechnicianTimeOff,
} from './entities';
import { ServicesModule } from '../services/services.module';
import { User } from '../users/entities/user.entity';
import { Service } from '../services/entities/service.entity';
import { TechnicianVerification } from '../technician-verifications/entities/technician-verification.entity';

import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';

@Module({
  imports: [
    ServicesModule,
    TypeOrmModule.forFeature([
      TechnicianProfile,
      TechnicianSkill,
      TechnicianSkillVerification,
      TechnicianServiceArea,
      TechnicianSchedule,
      TechnicianTimeOff,
      TechnicianAssignment,
      ServiceOrder,
      CommissionDue,
      User,
      Service,
      TechnicianVerification,
    ]),
  ],
  controllers: [TechniciansController, TechnicianOnboardingController],
  providers: [TechniciansService, TechnicianOnboardingService],
  exports: [TechniciansService, TechnicianOnboardingService, TypeOrmModule],
})
export class TechniciansModule {}
