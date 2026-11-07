// src/modules/part-requests/part-requests.module.ts
import { Module, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { assertCustodyRuntimeConfiguration } from './part-custody.policy';
import { ConditionalModule } from '@nestjs/config';
import { PartCustodyModule } from './part-custody.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartRequestsController } from './part-requests.controller';
import { PartRequestsService } from './part-requests.service';
import { DeliveryConsentPreviewController } from './delivery-consent-preview.controller';
import { DeliveryConsentPreviewService } from './delivery-consent-preview.service';
import { WarehouseDeliveryPreviewController } from './warehouse-delivery-preview.controller';
import { WarehouseDeliveryPreviewService } from './warehouse-delivery-preview.service';
import { PartRequest, PartRequestItem } from './entities';
import { FixHomePart } from '../parts-catalog/entities/fixhome-part.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { User } from '../users/entities/user.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RbacModule } from '../rbac/rbac.module';
import { WarehouseFulfillmentModule } from './warehouse-fulfillment.module';
import { MediaModule } from '../media/media.module';
import { DeliveryOperationsController } from './delivery-operations.controller';
import { DeliveryOperationsService } from './delivery-operations.service';

@Module({
  imports: [
    MediaModule,
    WarehouseFulfillmentModule,
    ConditionalModule.registerWhen(PartCustodyModule, env => env.P1_CUSTODY_ENABLED === 'true' || env.PART_RETURNS_TRACKING_ENABLED === 'true'),
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
  controllers: [PartRequestsController, DeliveryConsentPreviewController, WarehouseDeliveryPreviewController, DeliveryOperationsController],
  providers: [PartRequestsService, DeliveryConsentPreviewService, WarehouseDeliveryPreviewService, DeliveryOperationsService],
  exports: [PartRequestsService, TypeOrmModule],
})
export class PartRequestsModule implements OnModuleInit {
  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await assertCustodyRuntimeConfiguration(this.dataSource.manager);
  }
}
