// src/modules/services/services.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServicesController } from './services.controller';
import { AdminServicesController } from './admin-services.controller';
import { ServicesService } from './services.service';
import { Service } from './entities/service.entity';
import { ServiceCategory } from '../categories/entities/category.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Service, ServiceCategory])],
  controllers: [ServicesController, AdminServicesController],
  providers: [ServicesService],
  exports: [ServicesService, TypeOrmModule],
})
export class ServicesModule {}
