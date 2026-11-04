import { Module } from '@nestjs/common';
import { WarehouseFulfillmentService } from './warehouse-fulfillment.service';

@Module({ providers: [WarehouseFulfillmentService], exports: [WarehouseFulfillmentService] })
export class WarehouseFulfillmentModule {}
