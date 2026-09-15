// src/modules/parts-catalog/parts-catalog.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartsCatalogController } from './parts-catalog.controller';
import { AdminPartsController } from './admin-parts.controller';
import { PartsCatalogService } from './parts-catalog.service';
import { FixHomePart } from './entities/fixhome-part.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FixHomePart]),
    AuditLogModule,
    RbacModule,
  ],
  controllers: [PartsCatalogController, AdminPartsController],
  providers: [PartsCatalogService],
  exports: [PartsCatalogService, TypeOrmModule],
})
export class PartsCatalogModule {}
