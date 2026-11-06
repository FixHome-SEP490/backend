import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';
import { DeliveryConsentPreviewService } from './delivery-consent-preview.service';

@ApiTags('Part Requests')
@ApiBearerAuth()
@Controller('part-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DeliveryConsentPreviewController {
  constructor(
    @Inject(DeliveryConsentPreviewService)
    private readonly service: DeliveryConsentPreviewService,
  ) {}

  @Get(':id/delivery-consent/preview')
  @Roles(Role.CUSTOMER, Role.TECHNICIAN)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Xem trước điều kiện giao linh kiện, chưa thể thực hiện',
  })
  async preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    return {
      data: await this.service.preview(id, {
        id: req.user.id,
        role: req.user.role,
      }),
    };
  }
}
