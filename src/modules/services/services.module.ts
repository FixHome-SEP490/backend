// src/modules/services/services.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServicesController } from './services.controller';
import { AdminServicesController } from './admin-services.controller';
import { PartsController } from './parts.controller';
import { ServicesService } from './services.service';
import { Service } from './entities/service.entity';
import { PartCatalog } from './entities/part-catalog.entity';
import { ServiceCategory } from '../categories/entities/category.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Service, ServiceCategory, PartCatalog]),
    AuditLogModule,
    RbacModule,
  ],
  controllers: [ServicesController, AdminServicesController, PartsController],
  providers: [ServicesService],
  exports: [ServicesService, TypeOrmModule],
})
export class ServicesModule {}
