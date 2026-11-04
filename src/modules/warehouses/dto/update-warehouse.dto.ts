import { PartialType } from '@nestjs/swagger';
import { CreateWarehouseDto } from './create-warehouse.dto';
import { IsEnum, IsOptional } from 'class-validator';
import { WarehouseStatus } from '../entities';

export class UpdateWarehouseDto extends PartialType(CreateWarehouseDto) {
  @IsOptional()
  @IsEnum(WarehouseStatus)
  status?: WarehouseStatus;
}
