import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role } from '../../shared/enums';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WarehouseDeliveryPreviewService } from './warehouse-delivery-preview.service';

export class WarehouseDeliveryPreviewParams {
  @Matches(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)
  id: string;
}

@ApiTags('Part Requests')
@ApiBearerAuth()
@Controller('part-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WarehouseDeliveryPreviewController {
  constructor(
    @Inject(WarehouseDeliveryPreviewService)
    private readonly service: WarehouseDeliveryPreviewService,
  ) {}

  @Get(':id/delivery-physical/preview')
  @Roles(Role.CUSTOMER, Role.TECHNICIAN)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Xem điều kiện giao linh kiện và các bước chưa được mở',
  })
  async preview(
    @Param() params: WarehouseDeliveryPreviewParams,
    @Req() req: { user: { id: string; role: string } },
  ) {
    return {
      data: await this.service.preview(params.id, {
        id: req.user.id,
        role: req.user.role,
      }),
    };
  }
}
