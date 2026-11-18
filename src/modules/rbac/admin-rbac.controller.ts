import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { AdminRbacService } from './admin-rbac.service';
import { UpdateRolePermissionDto } from './dto/update-role-permission.dto';

@ApiTags('Admin / Service manager permissions')
@Controller('admin/rbac/service-manager/permissions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminRbacController {
  constructor(private readonly adminRbacService: AdminRbacService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: list what the service manager role may do' })
  list() {
    return this.adminRbacService.listServiceManagerPermissions();
  }

  @Put(':code')
  @ApiOperation({ summary: 'Admin: grant or revoke one service manager permission' })
  @ApiParam({ name: 'code', example: 'order:cancel' })
  update(
    @Param('code') code: string,
    @Body() dto: UpdateRolePermissionDto,
    @CurrentUser() user: User,
  ) {
    return this.adminRbacService.setServiceManagerPermission(code, dto.granted, {
      id: user.id,
      role: user.role,
    });
  }
}
