// src/modules/system-config/system-config.module.ts
import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemConfig } from './entities/system-config.entity';
import { BusinessConfigService } from './business-config.service';
import { AdminConfigService } from './admin-config.service';
import { AdminConfigController } from './admin-config.controller';

/**
 * Global module so that any service can inject BusinessConfigService
 * without importing SystemConfigModule explicitly.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SystemConfig])],
  controllers: [AdminConfigController],
  providers: [BusinessConfigService, AdminConfigService],
  exports: [BusinessConfigService, AdminConfigService],
})
export class SystemConfigModule {}
