import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { PartCustodyService } from './part-custody.service';
import { PartReturnsController } from './part-returns.controller';
import { WarehouseFulfillmentModule } from './warehouse-fulfillment.module';

@Module({ imports: [RbacModule, WarehouseFulfillmentModule], controllers: [PartReturnsController], providers: [PartCustodyService], exports: [PartCustodyService] })
export class PartCustodyModule {}
