import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FixHomePart } from '../parts-catalog/entities/fixhome-part.entity';
import { User } from '../users/entities/user.entity';
import { StockMovement, Warehouse, WarehouseStock } from './entities';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';

@Module({
  imports: [TypeOrmModule.forFeature([Warehouse, WarehouseStock, StockMovement, User, FixHomePart])],
  controllers: [WarehousesController],
  providers: [WarehousesService],
})
export class WarehousesModule {}
