// src/modules/technician-skill-verifications/technician-skill-verifications.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TechnicianSkillVerificationsController } from './technician-skill-verifications.controller';
import { AdminTechnicianSkillVerificationsController } from './admin-technician-skill-verifications.controller';
import { TechnicianSkillVerificationsService } from './technician-skill-verifications.service';
import { TechnicianSkillVerification } from '../technicians/entities/technician-skill-verification.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { VerificationDocument } from '../technician-verifications/entities/verification-document.entity';
import { TechnicianVerificationsModule } from '../technician-verifications/technician-verifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TechnicianSkillVerification,
      TechnicianSkill,
      TechnicianProfile,
      VerificationDocument,
    ]),
    TechnicianVerificationsModule, // for KycStorageService (reused as-is)
  ],
  controllers: [
    TechnicianSkillVerificationsController,
    AdminTechnicianSkillVerificationsController,
  ],
  providers: [TechnicianSkillVerificationsService],
  exports: [TechnicianSkillVerificationsService],
})
export class TechnicianSkillVerificationsModule {}
