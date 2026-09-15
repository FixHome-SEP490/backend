// src/modules/technicians/technicians.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TechniciansController } from './technicians.controller';
import { TechniciansService } from './technicians.service';
import {
  TechnicianProfile,
  TechnicianSkill,
  TechnicianServiceArea,
  TechnicianSchedule,
  TechnicianTimeOff,
} from './entities';

import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TechnicianProfile,
      TechnicianSkill,
      TechnicianServiceArea,
      TechnicianSchedule,
      TechnicianTimeOff,
      TechnicianAssignment,
      ServiceOrder,
      CommissionDue,
    ]),
  ],
  controllers: [TechniciansController],
  providers: [TechniciansService],
  exports: [TechniciansService, TypeOrmModule],
})
export class TechniciansModule {}

