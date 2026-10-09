import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';
import { AdjustReputationDto, QueryReputationDto } from './dto/reputation.dto';
import { ReputationService } from './reputation.service';

type Req = { user: { id: string; role: string } };

@ApiTags('Reputation (service manager)')
@Controller('reputation')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.SERVICE_MANAGER, Role.ADMIN)
@ApiBearerAuth()
export class ReputationController {
  constructor(private readonly service: ReputationService) {}

  @Get()
  @RequirePermission('strike:read_all')
  @ApiOperation({ summary: 'SM / Admin: customers and technicians by reputation points, lowest first' })
  list(@Query() query: QueryReputationDto) {
    return this.service.list(query);
  }

  @Get('me')
  @Roles(Role.CUSTOMER, Role.TECHNICIAN)
  @RequirePermission('profile:read_own')
  @ApiOperation({ summary: 'Customer / Technician: own reputation points, ban and history' })
  mine(@Req() req: Req) {
    return this.service.mine(req.user.id);
  }

  @Get(':userId/events')
  @RequirePermission('strike:read_all')
  @ApiOperation({ summary: 'SM / Admin: why a user\'s reputation points changed' })
  events(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.service.events(userId);
  }

  @Post(':userId/adjust')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('strike:waive')
  @ApiOperation({ summary: 'SM / Admin: add or remove reputation points with a reason' })
  adjust(@Req() req: Req, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: AdjustReputationDto) {
    return this.service.adjust(req.user, userId, dto.delta, dto.reason);
  }
}
