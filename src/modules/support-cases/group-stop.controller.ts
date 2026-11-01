import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { JwtAuthGuard, PermissionGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { GroupContactAttemptDto, GroupContactQueryDto, GroupStopDto } from './dto/group-stop.dto';
import { GroupStopService } from './group-stop.service';
import { SupportCaseActor } from './support-cases.service';

@ApiTags('Visit Groups')
@ApiBearerAuth()
@Controller('visit-groups')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
export class GroupStopController {
  constructor(private readonly service: GroupStopService) {}

  @Get(':id/contact-readiness')
  @Header('Cache-Control', 'no-store')
  @Roles(Role.TECHNICIAN)
  @RequirePermission('order:read_related')
  readiness(@Param('id', ParseUUIDPipe) id: string, @Query() query: GroupContactQueryDto, @CurrentUser() actor: SupportCaseActor) {
    return this.service.readiness(id, query.selectedOrderId, actor);
  }

  @Post(':id/contact-attempt')
  @HttpCode(200)
  @Roles(Role.TECHNICIAN)
  @RequirePermission('order:read_related')
  contact(@Param('id', ParseUUIDPipe) id: string, @Body() body: GroupContactAttemptDto, @CurrentUser() actor: SupportCaseActor) {
    return this.service.contact(id, body, actor);
  }

  @Post(':id/cannot-continue')
  @HttpCode(200)
  @Roles(Role.TECHNICIAN)
  @RequirePermission('order:read_related')
  stop(@Param('id', ParseUUIDPipe) id: string, @Body() body: GroupStopDto, @CurrentUser() actor: SupportCaseActor) {
    return this.service.stop(id, body, actor);
  }

  @Get(':id/stop-incidents')
  @Header('Cache-Control', 'no-store')
  @Roles(Role.SERVICE_MANAGER, Role.ADMIN)
  @RequirePermission('support:read_all')
  incidents(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: SupportCaseActor) {
    return this.service.incidents(id, actor);
  }
}
