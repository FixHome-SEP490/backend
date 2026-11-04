import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/decorators';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { RiskLimit } from '../../common/rate-limit/risk-rate-limit';
import { User } from '../users/entities/user.entity';
import { AdjustStockDto, CreateWarehouseDto, ListWarehouseRowsDto, UpdateWarehouseDto } from './dto';
import { WarehousesService } from './warehouses.service';

@ApiTags('Warehouses')
@ApiBearerAuth()
@Controller('warehouses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SERVICE_MANAGER)
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.warehouses.listWarehouses(user);
  }

  @Post()
  @RiskLimit('warehouse-stock')
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateWarehouseDto) {
    return this.warehouses.createWarehouse(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.warehouses.getWarehouse(id, user);
  }

  @Patch(':id')
  @RiskLimit('warehouse-stock')
  @Roles(Role.ADMIN)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWarehouseDto) {
    return this.warehouses.updateWarehouse(id, dto);
  }

  @Delete(':id')
  @RiskLimit('warehouse-stock')
  @Roles(Role.ADMIN)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.warehouses.deleteWarehouse(id);
    return { id, deleted: true };
  }

  @Get(':id/stock')
  stock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Query() page: ListWarehouseRowsDto,
  ) {
    return this.warehouses.listStock(id, user, page);
  }

  @Get(':id/movements')
  movements(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Query() page: ListWarehouseRowsDto,
  ) {
    return this.warehouses.listMovements(id, user, page);
  }

  @Post(':id/stock-adjustments')
  @RiskLimit('warehouse-stock')
  @Roles(Role.ADMIN, Role.SERVICE_MANAGER)
  adjustStock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustStockDto,
    @CurrentUser() user: User,
  ) {
    return this.warehouses.adjustStock(id, dto, user);
  }
}
