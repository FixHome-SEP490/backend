import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { JwtAuthGuard, PermissionGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { StopReplaceRequestDto } from './dto/stop-replace-request.dto';
import { SupportCaseActor, SupportCasesService } from './support-cases.service';

@ApiTags('Support Cases')
@ApiBearerAuth()
@Controller('service-orders')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
export class CustomerStopRequestController {
  constructor(private readonly supportCasesService: SupportCasesService) {}

  @Post(':id/stop-replace-request')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.CUSTOMER)
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'Customer: request manager review and hold completion for one order under repair' })
  async request(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StopReplaceRequestDto, @CurrentUser() actor: SupportCaseActor) {
    const supportCase = await this.supportCasesService.requestStopOrReplace(id, dto.reason, actor);
    return { data: await this.supportCasesService.findById(supportCase.id) };
  }
}
