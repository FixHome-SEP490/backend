// src/modules/system-config/system-config.module.ts
import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemConfig } from './entities/system-config.entity';
import { BusinessConfigService } from './business-config.service';
import { AdminConfigService } from './admin-config.service';
import { AdminConfigController } from './admin-config.controller';
import { W3DeliveryPolicyController } from './w3-delivery-policy-admin.controller';
import { W3DeliveryPolicyService } from './w3-delivery-policy-admin.service';
import { W3DeliveryPolicyStore } from './w3-delivery-policy-store.service';

/**
 * Global module so that any service can inject BusinessConfigService
 * without importing SystemConfigModule explicitly.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SystemConfig])],
  controllers: [AdminConfigController, W3DeliveryPolicyController],
  providers: [BusinessConfigService, AdminConfigService, W3DeliveryPolicyService, W3DeliveryPolicyStore],
  exports: [BusinessConfigService, AdminConfigService],
})
export class SystemConfigModule {}
