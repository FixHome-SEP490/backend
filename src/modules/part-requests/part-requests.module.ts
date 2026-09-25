// src/modules/part-requests/part-requests.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartRequestsController } from './part-requests.controller';
import { PartRequestsService } from './part-requests.service';
import { PartRequest, PartRequestItem } from './entities';
import { FixHomePart } from '../parts-catalog/entities/fixhome-part.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { User } from '../users/entities/user.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PartRequest,
      PartRequestItem,
      FixHomePart,
      ServiceOrder,
      User,
    ]),
    AuditLogModule,
    NotificationsModule,
    RbacModule,
  ],
  controllers: [PartRequestsController],
  providers: [PartRequestsService],
  exports: [PartRequestsService, TypeOrmModule],
})
export class PartRequestsModule {}
